const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// 1. CONFIGURACIÓN DE CARPETA TEMPORAL
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log("✅ Carpeta 'uploads' lista");
}

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// 2. CONFIGURACIÓN DE GOOGLE DRIVE
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'];
async function uploadToDrive(file) {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        const formattedKey = credentials.private_key.split(String.raw`\n`).join('\n');

        const auth = new google.auth.JWT(
            credentials.client_email,
            null,
            formattedKey,
            ['https://www.googleapis.com/auth/drive'] // Scope total para evitar restricciones
        );

        const drive = google.drive({ version: 'v3', auth });

        const fileMetadata = {
            name: file.filename,
            parents: ['1FgtrEXLOn4TfXxXkXSrXICiFTH4fa3-5']
        };

        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path)
        };

        // Cambiamos la estructura de la llamada
        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true,
            uploadType: 'multipart', // <--- ESTO ES CLAVE
        }, {
            // Este segundo objeto fuerza las opciones de red
            params: {
                supportsAllDrives: true
            }
        });

        console.log("✅ ¡POR FIN! Archivo en Drive con ID:", response.data.id);
        
        try { fs.unlinkSync(file.path); } catch (e) {}
        
        return response.data.id;
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("❌ Error detectado:", detail);
        throw error;
    }
}

// 3. RUTA PARA RECIBIR LA IMAGEN (Coincide con tu index.html)
app.post('/upload-to-drive', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No hay archivo' });
        
        console.log("📂 Recibida:", req.file.filename);
        const driveId = await uploadToDrive(req.file);
        
        res.json({ 
            success: true, 
            fileName: req.file.filename, 
            driveId: driveId 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. RUTA PARA REVISAR ESTADO (Polling)
app.get('/check-status/:fileName', async (req, res) => {
    try {
         // Busca esta parte dentro de la función uploadToDrive
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key.split(String.raw`\n`).join('\n'), // <-- Esto arregla el error 500
    SCOPES
);
        const drive = google.drive({ version: 'v3', auth });

        // Buscamos si existe un archivo con nombre similar (el editado)
        const response = await drive.files.list({
            q: `name contains '${req.params.fileName}' and mimeType contains 'image/'`,
            fields: 'files(id, name, thumbnailLink, webContentLink)',
            spaces: 'drive',
        });

        // Si hay más de un archivo, significa que ya está el original + el editado
        if (response.data.files && response.data.files.length > 1) {
            res.json({ status: 'ready', file: response.data.files[0] });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (error) {
        console.error("❌ Error en check-status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor joyeria en puerto ${PORT}`);
});














