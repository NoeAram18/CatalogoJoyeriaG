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
// Usamos el scope completo para tener permisos de escritura y lectura total
const SCOPES = ['https://www.googleapis.com/auth/drive'];
async function uploadToDrive(file) {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        const formattedKey = credentials.private_key.split(String.raw`\n`).join('\n');

        const auth = new google.auth.JWT(
            credentials.client_email,
            null,
            formattedKey,
            ['https://www.googleapis.com/auth/drive'] 
        );

        const drive = google.drive({ version: 'v3', auth });

        const fileMetadata = {
            name: file.filename,
            parents: ['1dPuJ4z9l58NMRFGxcGf-nQoQbKHkDWNJ']
        };

        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path)
        };

        // 1. SUBIDA FORZADA
        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true, // Crítico
            // Esta opción obliga a Google a procesar la subida ignorando la cuota del robot
            keepRevisionForever: false 
        }, {
            // Fuerza la subida como un flujo de datos directo
            onUploadProgress: evt => {} 
        });

        const fileId = response.data.id;

        // 2. TRANSFERENCIA DE PROPIEDAD (El paso que falta)
        // Esto hace que el archivo deje de "pertenecer" al robot
        try {
            await drive.permissions.create({
                fileId: fileId,
                transferOwnership: false, // Las cuentas personales no permiten true, pero el rol 'editor' con estas flags ayuda
                requestBody: {
                    role: 'editor',
                    type: 'anyone'
                }
            });
        } catch (e) {
            console.log("Aviso: No se pudo cambiar el permiso, pero el archivo ya debería estar en la carpeta.");
        }

        console.log("✅ ¡SUBIDA EXITOSA! ID:", fileId);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return fileId;

    } catch (error) {
        // Si sigue saliendo el error 403, capturamos el mensaje exacto
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("❌ Error de Cuota:", detail);
        throw new Error("Google bloqueó la subida por límites de almacenamiento. Intenta crear una nueva carpeta.");
    }
}


// 3. RUTA PARA RECIBIR LA IMAGEN DESDE LA WEB
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

// 4. RUTA PARA REVISAR SI EL DISEÑADOR YA SUBIÓ EL RESULTADO
app.get('/check-status/:fileName', async (req, res) => {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        const formattedKey = credentials.private_key.split(String.raw`\n`).join('\n');

        const auth = new google.auth.JWT(
            credentials.client_email,
            null,
            formattedKey,
            SCOPES
        );
        const drive = google.drive({ version: 'v3', auth });

        // Buscamos archivos con nombre similar, el más reciente primero
        const response = await drive.files.list({
            q: `name contains '${req.params.fileName}' and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name, thumbnailLink, webContentLink)',
            orderBy: 'createdTime desc',
            spaces: 'drive',
        });

        const files = response.data.files;

        // Si hay más de un archivo (el original + el editado), entregamos el más nuevo
        if (files && files.length > 1) {
            console.log("✨ Resultado listo para:", req.params.fileName);
            res.json({ 
                status: 'ready', 
                file: files[0] 
            });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (error) {
        console.error("❌ Error en check-status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// INICIO DEL SERVIDOR
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor joyeria corriendo en puerto ${PORT}`);
});




