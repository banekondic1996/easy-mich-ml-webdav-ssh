// Use modules from window scope
function getLocalIP() {
    const interfaces = window.os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const netInterface of interfaces[name]) {
            if (netInterface.family === 'IPv4' && !netInterface.internal) {
                return netInterface.address;
            }
        }
    }
    return null;
}

function getSubnet(ip) {
    return ip.split('.').slice(0, 3).join('.') + '.';
}

// Fast TCP port check
function checkPort(ip, port, timeout = 100) {
    return new Promise((resolve) => {
        const socket = window.net.Socket();
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            socket.destroy();
            resolve(ip);
        });

        socket.on('error', () => resolve(null));
        socket.on('timeout', () => {
            socket.destroy();
            resolve(null);
        });

        socket.connect(port, ip);
    });
}

// Fetch server name via HTTP
function getServerName(ip, port, timeout = 500) {
    return new Promise((resolve) => {
        const options = {
            host: ip,
            port: port,
            path: '/',
            method: 'GET',
            timeout: timeout,
            headers: {
                'User-Agent': 'EasyMichML/1.0'
            }
        };

        const req = window.http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                const name = data.trim() || ip; // Fallback to IP if no response
                resolve({ ip, name });
            });
        });

        req.on('error', () => resolve({ ip, name: ip }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ip, name: ip });
        });

        req.end();
    });
}

function limitConcurrency(tasks, limit) {
    return new Promise((resolve) => {
        const results = [];
        let running = 0;
        let index = 0;

        function runNext() {
            while (running < limit && index < tasks.length) {
                const task = tasks[index++];
                running++;
                task().then((result) => {
                    results.push(result);
                    running--;
                    runNext();
                });
            }
            if (running === 0) {
                resolve(results);
            }
        }

        runNext();
    });
}

async function scanNetwork(port) {
    const localIP = getLocalIP();
    if (!localIP) {
        console.error('Could not determine local IP');
        return [];
    }

    const subnet = getSubnet(localIP);
    console.log(`Scanning ${subnet}0/24 on port ${port}...`);

    // Step 1: Fast TCP scan for open ports
    const scanTasks = [];
    for (let i = 1; i < 255; i++) {
        const ip = `${subnet}${i}`;
        scanTasks.push(() => checkPort(ip, port));
    }

    const openIPs = (await limitConcurrency(scanTasks, 50)).filter(ip => ip);

    // Step 2: Fetch names for open ports only
    const nameTasks = openIPs.map(ip => () => getServerName(ip, port));
    const servers = await limitConcurrency(nameTasks, 50);

    return servers;
}

global.scanNetwork = scanNetwork;