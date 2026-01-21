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

app.post('/send-to-telegram', uploadFields, async (req, res) => {
    try {
        const userFile = req.files['userImage'] ? req.files['userImage'][0] : null;
        const catalogFile = req.files['catalogImage'] ? req.files['catalogImage'][0] : null;

        if (!userFile || !catalogFile) {
            return res.status(400).json({ success: false, error: 'Faltan imágenes' });
        }

        // Enviamos las fotos como un Grupo de Medios (Media Group) para que lleguen juntas
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        
        // Creamos el array de medios para Telegram
        const media = [
            {
                type: 'photo',
                media: 'attach://userPhoto',
                caption: `💎 **NUEVA SOLICITUD COMBINADA**\n👤 Foto del Cliente y Joya seleccionada.`
            },
            {
                type: 'photo',
                media: 'attach://catalogPhoto'
            }
        ];

        form.append('media', JSON.stringify(media));
        form.append('userPhoto', fs.createReadStream(userFile.path));
        form.append('catalogPhoto', fs.createReadStream(catalogFile.path));

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`,
            form,
            { headers: form.getHeaders() }
        );

        // Limpieza de archivos temporales
        fs.unlinkSync(userFile.path);
        fs.unlinkSync(catalogFile.path);

        res.json({ success: true });

    } catch (error) {
        console.error('❌ Error Telegram:', error.response?.data || error.message);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));
