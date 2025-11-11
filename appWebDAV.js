const { v2: webdav } = require('webdav-server');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'supersecurepassword';
const DEFAULT_ROOT_DIR = window.path.join(process.cwd(), 'webdav_files');
const MAX_ATTEMPTS = 5;
const TIMEOUT_SECONDS = 60;
const attempts = new Map();

function loadWebDAVConfig() {
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
        console.error('Error loading WebDAV config:', e);
    }
    const username = config.webdavUsername || DEFAULT_USERNAME;
    const password = config.webdavPassword.encrypted ? window.decryptPassword(config.webdavPassword) : DEFAULT_PASSWORD;
    const rootDir = config.webdavDirectory || DEFAULT_ROOT_DIR;
    return { username, password, rootDir };
}

const { username, password, rootDir } = loadWebDAVConfig();

if (!window.fs.existsSync(rootDir)) {
    window.fs.mkdirSync(rootDir, { recursive: true });
    console.log(`Created directory: ${rootDir}`);
}

const userManager = new webdav.SimpleUserManager();
const user = userManager.addUser(username, password, false);

const privilegeManager = new webdav.SimplePathPrivilegeManager();
privilegeManager.setRights(user, '/', ['all']);

const server = new webdav.WebDAVServer({
    port: 8080,
    rootFileSystem: new webdav.PhysicalFileSystem(rootDir),
    httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'WebDAV Realm'),
    privilegeManager: privilegeManager,
    autoIndex: true,
});

server.beforeRequest((ctx, next) => {
    const ip = ctx.request.socket.remoteAddress || 'unknown-ip';
    const now = Date.now();
    console.log(`Request from ${ip}: ${ctx.request.method} ${ctx.request.url}`);

    if (attempts.has(ip)) {
        const [count, lastAttempt] = attempts.get(ip);
        console.log(`IP ${ip} has ${count} attempts, last at ${lastAttempt}`);
        if (count >= MAX_ATTEMPTS && (now - lastAttempt) / 1000 < TIMEOUT_SECONDS) {
            console.log(`IP ${ip} blocked: Too many attempts`);
            ctx.response.statusCode = 429;
            ctx.response.end('Too many attempts');
            return;
        } else if (count >= MAX_ATTEMPTS) {
            console.log(`IP ${ip} timeout expired, resetting attempts`);
            attempts.delete(ip);
        }
    }

    const auth = ctx.request.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        console.log(`No or invalid auth header from ${ip}`);
        const newCount = (attempts.get(ip)?.[0] || 0) + 1;
        attempts.set(ip, [newCount, now]);
        console.log(`IP ${ip} failed attempt ${newCount}`);
        ctx.response.statusCode = 401;
        ctx.response.setHeader('WWW-Authenticate', 'Basic realm="WebDAV Realm"');
        ctx.response.end('Authentication required');
        return;
    }

    next();
});

server.on('unauthenticated', (ctx) => {
    const ip = ctx.request.socket.remoteAddress || 'unknown-ip';
    const now = Date.now();
    console.log(`Authentication failed for ${ip}`);
    const newCount = (attempts.get(ip)?.[0] || 0) + 1;
    attempts.set(ip, [newCount, now]);
    console.log(`IP ${ip} failed attempt ${newCount}`);
});

server.start(() => console.log('WebDAV server running at http://localhost:8080'));