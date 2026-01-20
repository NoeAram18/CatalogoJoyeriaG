const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' }); // Carpeta temporal

// --- CONFIGURACIÓN DE GOOGLE DRIVE ---
// Cargamos las credenciales desde la Variable de Entorno de Koyeb
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const FOLDER_PENDIENTES_ID = 'ID_DE_TU_CARPETA_PENDIENTES'; // Reemplaza esto
const FOLDER_FINALIZADOS_ID = 'ID_DE_TU_CARPETA_FINALIZADOS'; // Reemplaza esto

const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    ['https://www.googleapis.com/auth/drive']
);

const drive = google.drive({ version: 'v3', auth });

app.use(express.static('public')); // Para servir tu index.html
app.use(express.json());

// 1. ENDPOINT PARA SUBIR LA FOTO DEL CLIENTE
app.post('/upload-to-drive', upload.single('image'), async (req, res) => {
    try {
        const fileMetadata = {
            name: `CLIENTE_${Date.now()}_${req.body.jewelryId}.jpg`,
            parents: [FOLDER_PENDIENTES_ID]
        };
        const media = {
            mimeType: 'image/jpeg',
            body: fs.createReadStream(req.file.path)
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name'
        });

        // Borramos el archivo temporal
        fs.unlinkSync(req.file.path);

        res.json({ success: true, fileName: response.data.name });
    } catch (error) {
        console.error('Error en Drive:', error);
        res.status(500).json({ error: 'Error al subir a Drive' });
    }
});

// 2. ENDPOINT PARA BUSCAR LA FOTO YA EDITADA
app.get('/check-status/:fileName', async (req, res) => {
    try {
        const fileName = req.params.fileName;
        // Buscamos un archivo con el mismo nombre en la carpeta de FINALIZADOS
        const response = await drive.files.list({
            q: `'${FOLDER_FINALIZADOS_ID}' in parents and name = '${fileName}' and trashed = false`,
            fields: 'files(id, name, webContentLink, thumbnailLink)'
        });

        if (response.data.files.length > 0) {
            // Si el archivo existe, devolvemos el link de la imagen
            res.json({ status: 'ready', file: response.data.files[0] });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error al buscar archivo' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor joyeria corriendo en puerto ${PORT}`));



