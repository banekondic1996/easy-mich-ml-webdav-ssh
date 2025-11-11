const { Server } = require('ssh2');
const { execSync } = require('child_process');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'michmich';
const DEFAULT_ROOT_DIR = window.path.join(process.cwd(), 'sftp_files');
const KEY_PATH = window.path.join(process.cwd(), 'sftp_key');
const PORT = 2222;

function generateTempKey() {
    if (!window.fs.existsSync(KEY_PATH)) {
        try {
            execSync(`ssh-keygen -t rsa -b 2048 -f ${KEY_PATH} -N "" -q`);
            console.log(`Generated temporary private key at ${KEY_PATH}`);
        } catch (e) {
            console.error('Failed to generate SSH key:', e.message);
            throw new Error('SSH key generation failed. Ensure ssh-keygen is installed.');
        }
    } else {
        console.log(`Using existing private key at ${KEY_PATH}`);
    }
}

function loadSFTPConfig() {
    const configPath = window.path.join(process.cwd(), 'config.json');
    let config = {
        webdavUsername: DEFAULT_USERNAME,
        webdavPassword: { iv: '', encrypted: '' },
        webdavDirectory: DEFAULT_ROOT_DIR
    };
    try {
        if (window.fs.existsSync(configPath)) {
            config = JSON.parse(window.fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading SFTP config:', e);
    }
    const username = config.webdavUsername || DEFAULT_USERNAME;
    const password = config.webdavPassword.encrypted && window.decryptPassword 
        ? window.decryptPassword(config.webdavPassword) 
        : DEFAULT_PASSWORD;
    const rootDir = config.webdavDirectory || DEFAULT_ROOT_DIR;
    return { username, password, rootDir };
}

const { username, password, rootDir } = loadSFTPConfig();

if (!window.fs.existsSync(rootDir)) {
    window.fs.mkdirSync(rootDir, { recursive: true });
    console.log(`Created directory: ${rootDir}`);
}

generateTempKey();

const server = new Server({
    hostKeys: [window.fs.readFileSync(KEY_PATH)]
}, (client) => {
    console.log('Client connected');

    client.on('authentication', (ctx) => {
        // Check username and password
        if (ctx.method === 'password') {
            if (ctx.username === username && ctx.password === 'michmich') {
                console.log(`User ${ctx.username} authenticated successfully`);
                ctx.accept();
            } else {
                console.log(`Authentication failed for ${ctx.username}: wrong credentials`);
                ctx.reject(['password']); // Still allow password attempts
            }
        } else {
            console.log(`Authentication method ${ctx.method} not supported`);
            ctx.reject(['password']); // Tell client we only support password
        }
    }).on('ready', () => {
        console.log('Client authenticated and ready');
        
        client.on('session', (accept, reject) => {
            const session = accept();
            
            session.on('sftp', (accept, reject) => {
                console.log('SFTP session started');
                const sftpStream = accept();
                
                // File and directory handle tracking
                const fileHandles = new Map();
                const dirHandles = new Map();
                let handleCounter = 0;

                // REALPATH - Get absolute path
                sftpStream.on('REALPATH', (reqid, path) => {
                    console.log(`REALPATH: ${path}`);
                    const fullPath = path === '/' || path === '.' || path === '' 
                        ? rootDir 
                        : window.path.join(rootDir, path);
                    
                    window.fs.stat(fullPath, (err, stats) => {
                        if (err) {
                            console.error(`REALPATH error: ${err.message}`);
                            sftpStream.status(reqid, 2); // NO_SUCH_FILE
                        } else {
                            const filename = path === '/' || path === '.' || path === '' ? '/' : path;
                            sftpStream.name(reqid, [{
                                filename: filename,
                                longname: `drwxr-xr-x 1 ${username} ${username} ${stats.size} Jan 1 00:00 ${window.path.basename(filename) || '/'}`,
                                attrs: {
                                    mode: stats.mode,
                                    uid: stats.uid,
                                    gid: stats.gid,
                                    size: stats.size,
                                    atime: stats.atime,
                                    mtime: stats.mtime
                                }
                            }]);
                        }
                    });
                });

                // OPENDIR - Open directory for reading
                sftpStream.on('OPENDIR', (reqid, pathName) => {
                    console.log(`OPENDIR: reqid=${reqid} path="${pathName}"`);
                    const fullPath = pathName === '/' || pathName === '.' || pathName === '' 
                        ? rootDir 
                        : window.path.join(rootDir, pathName);
                    
                    window.fs.stat(fullPath, (err, stats) => {
                        if (err || !stats.isDirectory()) {
                            console.error(`OPENDIR error: ${err ? err.message : 'Not a directory'}`);
                            sftpStream.status(reqid, 2); // NO_SUCH_FILE
                            return;
                        }
                        
                        const handle = Buffer.alloc(4);
                        handle.writeUInt32BE(handleCounter++, 0);
                        const handleStr = handle.toString('hex');
                        dirHandles.set(handleStr, { path: fullPath, read: false });
                        console.log(`OPENDIR handle created: ${handleStr} for path: ${fullPath}`);
                        sftpStream.handle(reqid, handle);
                    });
                });

                // READDIR - Read directory contents (robust, handles concurrent READDIRs)
sftpStream.on('READDIR', (reqid, handle) => {
    const handleStr = handle.toString('hex');
    const dirInfo = dirHandles.get(handleStr);

    if (!dirInfo) {
        console.error(`READDIR: Invalid handle ${handleStr}`);
        return sftpStream.status(reqid, 2); // SSH_FX_NO_SUCH_FILE
    }

    // If we've already completed reading this handle, immediately return EOF
    if (dirInfo.read) {
        // Optional: quieter logging for repeated EOFs
        if (!dirInfo.loggedEof) {
            console.log(`READDIR: EOF for handle ${handleStr}`);
            dirInfo.loggedEof = true;
        }
        return sftpStream.status(reqid, 1); // SSH_FX_EOF
    }

    // Ensure we have a pending list and inProgress flag
    if (!dirInfo.pending) dirInfo.pending = [];
    if (!dirInfo.inProgress) {
        // First request: mark inProgress and queue the reqid
        dirInfo.inProgress = true;
        dirInfo.pending.push(reqid);

        console.log(`READDIR: Starting readdir for ${dirInfo.path} (handle ${handleStr})`);

        window.fs.readdir(dirInfo.path, (err, list) => {
            // If the handle was closed meanwhile, stop and do nothing
            if (!dirHandles.has(handleStr)) {
                console.log(`READDIR: handle ${handleStr} closed before readdir completed — dropping reply`);
                return;
            }

            // If we got an error, respond to all pending with FAILURE (and mark read to avoid loops)
            if (err) {
                console.error(`READDIR error for ${dirInfo.path}: ${err.message}`);
                const pending = dirInfo.pending.splice(0);
                dirInfo.inProgress = false;
                dirInfo.read = true; // avoid repeated failing attempts
                pending.forEach(rid => sftpStream.status(rid, 2)); // SSH_FX_FAILURE / NO_SUCH_FILE
                return;
            }

            // If directory empty, respond with EOF for all pending
            if (!list || list.length === 0) {
                console.log(`READDIR: Empty directory ${dirInfo.path} (handle ${handleStr}), sending EOF`);
                const pending = dirInfo.pending.splice(0);
                dirInfo.inProgress = false;
                dirInfo.read = true;
                pending.forEach(rid => sftpStream.status(rid, 1)); // SSH_FX_EOF
                return;
            }

            // Collect file entries (stat each, then respond to all pending reqids with same list)
            const files = [];
            let processed = 0;

            list.forEach(name => {
                const fullPath = window.path.join(dirInfo.path, name);
                window.fs.stat(fullPath, (stErr, stats) => {
                    if (!stErr) {
                        const isDir = stats.isDirectory();
                        files.push({
                            filename: name,
                            longname: `${isDir ? 'd' : '-'}rwxr-xr-x 1 ${username} ${username} ${stats.size} Jan 1 00:00 ${name}`,
                            attrs: {
                                mode: stats.mode,
                                uid: stats.uid,
                                gid: stats.gid,
                                size: stats.size,
                                atime: stats.atime,
                                mtime: stats.mtime
                            }
                        });
                    }
                    processed++;
                    if (processed === list.length) {
                        // Before sending, re-check the handle exists
                        if (!dirHandles.has(handleStr)) {
                            console.log(`READDIR: handle ${handleStr} closed while processing stats — dropping reply`);
                            dirInfo.inProgress = false;
                            dirInfo.pending = []; // clear
                            return;
                        }

                        const pending = dirInfo.pending.splice(0);
                        dirInfo.inProgress = false;
                        dirInfo.read = true; // only mark read after successful response
                        console.log(`READDIR: Sending ${files.length} items for handle ${handleStr} to ${pending.length} request(s)`);
                        pending.forEach(rid => sftpStream.name(rid, files));
                    }
                });
            });
        });
    } else {
        // Another READDIR arrived while a readdir is in progress: queue it and return (will be answered later)
        dirInfo.pending.push(reqid);
        console.log(`READDIR: Queued reqid ${reqid} for handle ${handleStr} (already in progress)`);
    }
});

                // OPEN - Open file
                sftpStream.on('OPEN', (reqid, filename, flags, attrs) => {
                    console.log(`OPEN: ${filename}, flags: ${flags}`);
                    const fullPath = window.path.join(rootDir, filename);
                    
                    // Determine mode based on flags
                    let mode = 'r';
                    if (flags & 0x00000002) mode = 'w'; // WRITE
                    if (flags & 0x00000008) mode = 'w'; // CREATE
                    if (flags & 0x00000001) mode = 'a'; // APPEND
                    
                    window.fs.open(fullPath, mode, (err, fd) => {
                        if (err) {
                            console.error(`OPEN error: ${err.message}`);
                            sftpStream.status(reqid, 2); // NO_SUCH_FILE
                        } else {
                            const handle = Buffer.alloc(4);
                            handle.writeUInt32BE(handleCounter++, 0);
                            fileHandles.set(handle.toString('hex'), { fd, path: fullPath });
                            console.log(`OPEN handle created: ${handle.toString('hex')}, fd: ${fd}`);
                            sftpStream.handle(reqid, handle);
                        }
                    });
                });

                // READ - Read from file
                sftpStream.on('READ', (reqid, handle, offset, length) => {
                    console.log(`READ: handle ${handle.toString('hex')}, offset: ${offset}, length: ${length}`);
                    const fileHandle = fileHandles.get(handle.toString('hex'));
                    
                    if (!fileHandle) {
                        console.error('READ: Invalid handle');
                        sftpStream.status(reqid, 2); // NO_SUCH_FILE
                        return;
                    }

                    const buffer = Buffer.alloc(length);
                    window.fs.read(fileHandle.fd, buffer, 0, length, offset, (err, bytesRead) => {
                        if (err) {
                            console.error(`READ error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else if (bytesRead === 0) {
                            console.log('READ: EOF');
                            sftpStream.status(reqid, 1); // EOF
                        } else {
                            console.log(`READ: ${bytesRead} bytes`);
                            sftpStream.data(reqid, buffer.slice(0, bytesRead));
                        }
                    });
                });

                // WRITE - Write to file
                sftpStream.on('WRITE', (reqid, handle, offset, data) => {
                    console.log(`WRITE: handle ${handle.toString('hex')}, offset: ${offset}, length: ${data.length}`);
                    const fileHandle = fileHandles.get(handle.toString('hex'));
                    
                    if (!fileHandle) {
                        console.error('WRITE: Invalid handle');
                        sftpStream.status(reqid, 2); // NO_SUCH_FILE
                        return;
                    }

                    window.fs.write(fileHandle.fd, data, 0, data.length, offset, (err) => {
                        if (err) {
                            console.error(`WRITE error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else {
                            console.log('WRITE: Success');
                            sftpStream.status(reqid, 0); // OK
                        }
                    });
                });

                // CLOSE - Close file or directory handle
                sftpStream.on('CLOSE', (reqid, handle) => {
                    console.log(`CLOSE: handle ${handle.toString('hex')}`);
                    const handleStr = handle.toString('hex');
                    const fileHandle = fileHandles.get(handleStr);
                    
                    if (fileHandle) {
                        window.fs.close(fileHandle.fd, (err) => {
                            if (err) {
                                console.error(`CLOSE error: ${err.message}`);
                                sftpStream.status(reqid, 2); // FAILURE
                            } else {
                                fileHandles.delete(handleStr);
                                console.log('CLOSE: Success (file)');
                                sftpStream.status(reqid, 0); // OK
                            }
                        });
                    } else if (dirHandles.has(handleStr)) {
                        dirHandles.delete(handleStr);
                        console.log('CLOSE: Success (directory)');
                        sftpStream.status(reqid, 0); // OK
                    } else {
                        console.log('CLOSE: Handle not found (already closed?)');
                        sftpStream.status(reqid, 0); // OK - Don't error on double close
                    }
                });

                // STAT/LSTAT - Get file/directory attributes
                const handleStat = (reqid, path, followSymlinks) => {
                    console.log(`${followSymlinks ? 'STAT' : 'LSTAT'}: ${path}`);
                    const fullPath = window.path.join(rootDir, path);
                    
                    const statFn = followSymlinks ? window.fs.stat : window.fs.lstat;
                    statFn(fullPath, (err, stats) => {
                        if (err) {
                            console.error(`STAT error: ${err.message}`);
                            sftpStream.status(reqid, 2); // NO_SUCH_FILE
                        } else {
                            sftpStream.attrs(reqid, {
                                mode: stats.mode,
                                uid: stats.uid,
                                gid: stats.gid,
                                size: stats.size,
                                atime: stats.atime,
                                mtime: stats.mtime
                            });
                        }
                    });
                };

                sftpStream.on('STAT', (reqid, path) => handleStat(reqid, path, true));
                sftpStream.on('LSTAT', (reqid, path) => handleStat(reqid, path, false));

                // MKDIR - Create directory
                sftpStream.on('MKDIR', (reqid, path, attrs) => {
                    console.log(`MKDIR: ${path}`);
                    const fullPath = window.path.join(rootDir, path);
                    
                    window.fs.mkdir(fullPath, (err) => {
                        if (err) {
                            console.error(`MKDIR error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else {
                            console.log('MKDIR: Success');
                            sftpStream.status(reqid, 0); // OK
                        }
                    });
                });

                // RMDIR - Remove directory
                sftpStream.on('RMDIR', (reqid, path) => {
                    console.log(`RMDIR: ${path}`);
                    const fullPath = window.path.join(rootDir, path);
                    
                    window.fs.rmdir(fullPath, (err) => {
                        if (err) {
                            console.error(`RMDIR error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else {
                            console.log('RMDIR: Success');
                            sftpStream.status(reqid, 0); // OK
                        }
                    });
                });

                // REMOVE - Delete file
                sftpStream.on('REMOVE', (reqid, path) => {
                    console.log(`REMOVE: ${path}`);
                    const fullPath = window.path.join(rootDir, path);
                    
                    window.fs.unlink(fullPath, (err) => {
                        if (err) {
                            console.error(`REMOVE error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else {
                            console.log('REMOVE: Success');
                            sftpStream.status(reqid, 0); // OK
                        }
                    });
                });

                // RENAME - Rename/move file
                sftpStream.on('RENAME', (reqid, oldPath, newPath) => {
                    console.log(`RENAME: ${oldPath} -> ${newPath}`);
                    const fullOldPath = window.path.join(rootDir, oldPath);
                    const fullNewPath = window.path.join(rootDir, newPath);
                    
                    window.fs.rename(fullOldPath, fullNewPath, (err) => {
                        if (err) {
                            console.error(`RENAME error: ${err.message}`);
                            sftpStream.status(reqid, 2); // FAILURE
                        } else {
                            console.log('RENAME: Success');
                            sftpStream.status(reqid, 0); // OK
                        }
                    });
                });
            });
        });
    }).on('end', () => {
        console.log('Client disconnected');
    }).on('error', (err) => {
        console.error(`Client error: ${err.message}`);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`SFTP server running on 127.0.0.1:${PORT}`);
    console.log(`Username: ${username}`);
    console.log(`Root directory: ${rootDir}`);
});

server.on('error', (err) => {
    console.error(`SFTP server error: ${err.message}`);
    process.exit(1);
});