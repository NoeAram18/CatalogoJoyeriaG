require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// --- MODIFICACIÓN 1: CORS ABIERTO ---
// Esto permite que tu GitHub Pages se comunique con el servidor de Koyeb sin bloqueos
app.use(cors());

// Aumentamos el límite para recibir fotos de buena calidad
app.use(express.json({ limit: '20mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- MODIFICACIÓN 2: RUTA DE SALUD (HEALTH CHECK) ---
// Koyeb necesita esta ruta para saber que tu servidor arrancó bien. 
// Si no la pones, Koyeb dirá "Unhealthy" y cancelará el despliegue.
app.get('/', (req, res) => {
    res.send('Servidor de Joyería IA funcionando correctamente ✅');
});

app.post('/procesar', async (req, res) => {
    try {
        const { image1, image2, promptUser } = req.body;

        // Usamos gemini-1.5-flash que es el más rápido para la nube
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const promptSistema = `
            Actúa como un experto en joyería y estilismo. 
            Analiza la Persona (Imagen 1) y la Joya (Imagen 2).
            Explica cómo se integraría la joya físicamente (caída, posición, reflejos).
            Instrucción del usuario: ${promptUser || 'Ninguna'}.
        `;

        const result = await model.generateContent([
            { text: promptSistema },
            { inlineData: { data: image1, mimeType: "image/jpeg" } },
            { inlineData: { data: image2, mimeType: "image/jpeg" } }
        ]);

        const response = await result.response;
        res.json({ success: true, result: response.text() });

    } catch (error) {
        console.error("Error en el servidor:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- MODIFICACIÓN 3: PUERTO DINÁMICO ---
// En tu computadora usabas el 3000 fijo, pero en la nube 
// Koyeb te asigna uno al azar a través de process.env.PORT
const PORT = process.env.PORT || 8000; 

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
