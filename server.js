const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de subida temporal
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/upload-to-drive', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No hay foto' });

        const jewelryId = req.body.jewelryId || 'No especificada';
        
        // Preparamos el formulario para Telegram
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('photo', fs.createReadStream(req.file.path));
        form.append('caption', `💎 **NUEVO PEDIDO DE DISEÑO**\n\n💍 Joya elegida: ${jewelryId}\n📂 Archivo: ${req.file.originalname}`);

        // Enviamos a la API de Telegram
        const telegramRes = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`,
            form,
            { headers: form.getHeaders() }
        );

        // Borramos el archivo del servidor de Koyeb para no llenar espacio
        fs.unlinkSync(req.file.path);

        console.log("✅ Foto enviada a Telegram");
        res.json({ 
            success: true, 
            fileName: req.file.filename 
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ success: false, error: 'Error al enviar a Telegram' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
