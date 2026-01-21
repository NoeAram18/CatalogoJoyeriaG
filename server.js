const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();

// --- ASEGURAR QUE EXISTE LA CARPETA UPLOADS ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: 'uploads/' });

// --- MANEJO SEGURO DE CREDENCIALES ---
let GOOGLE_CREDENTIALS;
try {
    // Trim para evitar errores de espacios y parseo del JSON
    GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON.trim());
} catch (e) {
    console.error("ERROR: No se pudo procesar el JSON de Google. Verifica las Variables de Entorno en Koyeb.");
}

const folderId = '1EYcfC0mvvB8YcqOvRbcayEzeXrNohv7D';
const FOLDER_FINALIZADOS_ID = '1m4Zkt9BPI0nOu1KTGx8xeReRj8Ex4g2B'; 

// Corrección de la llave privada (reemplaza los saltos de línea literales \n)
const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
);

const drive = google.drive({ version: 'v3', auth });

app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.json());

// 1. ENDPOINT PARA SUBIR LA FOTO DEL CLIENTE
app.post('/upload-to-drive', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ninguna imagen' });
        }

        const fileMetadata = {
            name: `CLIENTE_${Date.now()}_${req.body.jewelryId}.jpg`,
            parents: [FOLDER_PENDIENTES_ID]
        };
        const media = {
            mimeType: req.file.mimetype,
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
        const response = await drive.files.list({
            q: `'${FOLDER_FINALIZADOS_ID}' in parents and name = '${fileName}' and trashed = false`,
            fields: 'files(id, name, webContentLink, thumbnailLink)'
        });

        if (response.data.files && response.data.files.length > 0) {
            res.json({ status: 'ready', file: response.data.files[0] });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (error) {
        console.error('Error al buscar:', error);
        res.status(500).json({ error: 'Error al buscar archivo' });
    }
});

// Ruta para servir el index.html explícitamente si no carga solo
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
// Escuchar en 0.0.0.0 es necesario para Koyeb
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Servidor joyeria corriendo en puerto ${PORT}`));

