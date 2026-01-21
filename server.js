const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de subida para dos campos de archivo
const upload = multer({ dest: 'uploads/' });
const uploadFields = upload.fields([
    { name: 'userImage', maxCount: 1 },
    { name: 'catalogImage', maxCount: 1 }
]);

app.use(express.static('public'));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Cambia el endpoint en server.js por este:
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; // Recibimos la ruta: 'images/anillo1.jpg'

        if (!userFile || !catalogPath) {
            return res.status(400).json({ success: false, error: 'Faltan datos' });
        }

        // Construimos la ruta real en el servidor
        const fullCatalogPath = `./public/${catalogPath}`;

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        
        const media = [
            {
                type: 'photo',
                media: 'attach://userPhoto',
                caption: `💎 **NUEVA SOLICITUD**\nFoto del cliente y referencia del catálogo.`
            },
            {
                type: 'photo',
                media: 'attach://catalogPhoto'
            }
        ];

        form.append('media', JSON.stringify(media));
        form.append('userPhoto', fs.createReadStream(userFile.path));
        form.append('catalogPhoto', fs.createReadStream(fullCatalogPath));

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`,
            form,
            { headers: form.getHeaders() }
        );

        // Borrar solo la foto temporal del usuario
        fs.unlinkSync(userFile.path);

        res.json({ success: true });

    } catch (error) {
        console.error('❌ Error detallado:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));

