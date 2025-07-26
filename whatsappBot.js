const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    // Print QR code in terminal to login
    qrcode.generate(qr, { small: true });
    console.log('Scan this QR with WhatsApp!');
});

client.on('ready', () => {
    console.log('WhatsApp bot is ready!');
});

// Start client
client.initialize();

module.exports = client;
