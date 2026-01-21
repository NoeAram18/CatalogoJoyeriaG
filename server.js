const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// "Buzón" temporal para guardar las ediciones que el diseñador envía
let buzónEdiciones = {}; 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// 1. RECIBIR DEL CLIENTE Y ENVIAR A TELEGRAM
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const clientId = Date.now(); // Generamos un ID único para este cliente
        const catalogPath = req.body.catalogPath;

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('photo', fs.createReadStream(req.file.path));
        form.append('caption', `🆔 ID Cliente: ${clientId}\n💍 Joya: ${catalogPath}\n\nInstrucciones: Edite la foto y responda a este mensaje con la imagen editada.`);

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form, {
            headers: form.getHeaders()
        });

        fs.unlinkSync(req.file.path);
        res.json({ success: true, clientId: clientId });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// 2. WEBHOOK: ESCUCHAR CUANDO TÚ RESPONDAS DESDE TELEGRAM
// Debes configurar el Webhook de Telegram hacia esta URL: tu-app.koyeb.app/telegram-webhook
app.post('/telegram-webhook', upload.single('photo'), async (req, res) => {
    const msg = req.body.message;
    
    // Si el mensaje es una foto y responde a uno anterior que tiene el ID
    if (msg && msg.reply_to_message && msg.photo) {
        const text = msg.reply_to_message.caption || "";
        const match = text.match(/ID Cliente: (\d+)/);
        
        if (match) {
            const clientId = match[1];
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            
            // Obtenemos la URL de la foto de los servidores de Telegram
            const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            const filePath = fileRes.data.result.file_path;
            const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
            
            // Guardamos la URL en nuestro buzón para ese cliente
            buzónEdiciones[clientId] = finalUrl;
        }
    }
    res.sendStatus(200);
});

// 3. LA WEB CONSULTA SI YA ESTÁ SU FOTO
app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    if (buzónEdiciones[id]) {
        res.json({ ready: true, url: buzónEdiciones[id] });
        // Opcional: borrar después de entregar para no llenar la memoria
        // delete buzónEdiciones[id]; 
    } else {
        res.json({ ready: false });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor listo`));
