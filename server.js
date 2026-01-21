const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de multer para guardar fotos temporales
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; // Ej: "images/anillo1.jpg"

        if (!userFile || !catalogPath) {
            return res.status(400).json({ success: false, error: 'Faltan datos.' });
        }

        // 1. Construimos la ruta absoluta a la imagen del catálogo
        // Importante: Asegúrate que tus fotos estén en public/images/
        const fullCatalogPath = path.join(__dirname, 'public', catalogPath);

        // Verificamos si la imagen del catálogo existe antes de enviarla
        if (!fs.existsSync(fullCatalogPath)) {
            console.error(`❌ No existe el archivo: ${fullCatalogPath}`);
            return res.status(404).json({ success: false, error: 'Joya no encontrada en catálogo.' });
        }

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        
        // Estructura para enviar álbum (MediaGroup)
        const media = [
            {
                type: 'photo',
                media: 'attach://userPhoto',
                caption: `👤 **FOTO DEL CLIENTE**`
            },
            {
                type: 'photo',
                media: 'attach://catalogPhoto',
                caption: `💍 **JOYA SELECCIONADA**: ${path.basename(catalogPath)}`
            }
        ];

        form.append('media', JSON.stringify(media));
        
        // Adjuntamos ambos archivos físicos
        form.append('userPhoto', fs.createReadStream(userFile.path));
        form.append('catalogPhoto', fs.createReadStream(fullCatalogPath));

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`,
            form,
            { 
                headers: { ...form.getHeaders() },
                timeout: 30000 // 30 segundos de margen
            }
        );

        // Borramos la foto temporal que subió el usuario
        fs.unlinkSync(userFile.path);

        res.json({ success: true });

    } catch (error) {
        if (error.response) {
            console.error('❌ Error de Telegram:', error.response.data);
        } else {
            console.error('❌ Error general:', error.message);
        }
        res.status(500).json({ success: false, error: 'Error al enviar a Telegram' });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
