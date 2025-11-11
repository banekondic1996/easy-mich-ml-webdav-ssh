function ddnsUpdate(ip, username, password, callback) {
    const hostname = `all.ddnskey.com`;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const url = `http://dynupdate.no-ip.com/nic/update?hostname=${hostname}&myip=${ip}`;

    const options = {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`,
            'User-Agent': 'EasyMichML/1.0'
        }
    };

    const req = window.http.request(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log(`DDNS Update Response: ${data}`);
            if (data.includes('good') || data.includes('nochg')) {
                console.log(`Successfully updated DDNS with IP: ${ip}`);
                if (callback) callback({ success: true });
            } else {
                console.error(`DDNS update failed: ${data}`);
                if (callback) callback({ success: false, message: data });
            }
        });
    });

    req.on('error', (e) => {
        console.error(`DDNS update error: ${e.message}`);
        if (callback) callback({ success: false, message: e.message });
    });

    req.end();
}

function startDDNSInterval() {
    const configPath = window.path.join(process.cwd(), 'config.json');
    let config = { dnsUsername: '', dnsPassword: { iv: '', encrypted: '' }, updateInterval: 60 };
    try {
        if (window.fs.existsSync(configPath)) {
            config = JSON.parse(window.fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading config for DDNS interval:', e);
    }

    const intervalMinutes = config.updateInterval || 60;
    const intervalMs = intervalMinutes * 60 * 1000;
    const decryptedPassword = config.dnsPassword.encrypted ? window.decryptPassword(config.dnsPassword) : '';

    // Initial update if needed
    window.fetchPublicIP().then(ip => {
        if (ip && config.dnsUsername && decryptedPassword && shouldUpdateDDNS()) {
            ddnsUpdate(ip, config.dnsUsername, decryptedPassword);
        }
    });

    // Periodic updates
    setInterval(async () => {
        const ip = await window.fetchPublicIP();
        if (ip && config.dnsUsername && decryptedPassword && shouldUpdateDDNS()) {
            ddnsUpdate(ip, config.dnsUsername, decryptedPassword, (status) => {
                if (status.success) {
                    config.lastDDNSUpdate = Date.now();
                    window.fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
                }
            });
        }
    }, intervalMs);

    console.log(`DDNS update interval set to ${intervalMinutes} minutes`);
}

function shouldUpdateDDNS() {
    const configPath = window.path.join(process.cwd(), 'config.json');
    let config = { updateInterval: 60, lastDDNSUpdate: 0 };
    try {
        if (window.fs.existsSync(configPath)) {
            config = JSON.parse(window.fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading config for DDNS check:', e);
    }
    const now = Date.now();
    const intervalMs = config.updateInterval * 60 * 1000;
    return !config.lastDDNSUpdate || (now - config.lastDDNSUpdate >= intervalMs);
}

global.ddnsUpdate = ddnsUpdate;
global.startDDNSInterval = startDDNSInterval;

startDDNSInterval();