const crypto = require('crypto');
const fs = require('fs');

function getKeyFromPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 65536, 32, 'sha256');
}

function decryptImage(inputPath, outputPath, password) {
    const inputFile = fs.readFileSync(inputPath);
    const salt = inputFile.slice(0, 16);  // Read the first 16 bytes (Salt)
    const iv = inputFile.slice(16, 32);   // Read the next 16 bytes (IV)
    const encryptedData = inputFile.slice(32);  // The rest is encrypted

    const key = getKeyFromPassword(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    fs.writeFileSync(outputPath, decrypted);
    console.log("Decryption complete!");
}

// Usage Example
decryptImage('encrypted_image.enc', 'decrypted_image.jpg', 'randompassword123');
