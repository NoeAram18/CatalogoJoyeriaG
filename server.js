require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// --- CONFIGURACIÓN DE MIDDLEWARES ---
// CORS permite que tu página de GitHub Pages hable con el servidor de Koyeb
app.use(cors());
// Aumentamos el límite de tamaño para poder recibir fotos en alta resolución
app.use(express.json({ limit: '20mb' }));

// Inicialización de la IA de Google
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- RUTA DE SALUD (HEALTH CHECK) ---
// Vital para que Koyeb marque el servicio como "Healthy"
app.get('/', (req, res) => {
    res.send('Servidor de Joyería IA funcionando correctamente ✅');
});

// --- RUTA PRINCIPAL DE PROCESAMIENTO ---
app.post('/procesar', async (req, res) => {
    try {
        const { image1, image2, promptUser } = req.body;

        if (!image1 || !image2) {
            return res.status(400).json({ success: false, error: "Faltan imágenes" });
        }

        // CAMBIO REALIZADO: Usamos 'gemini-1.5-flash-latest' para evitar el error 404 de versión
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const promptSistema = `
            Eres un experto en estilismo y joyería de alta gama.
            Analiza las dos imágenes proporcionadas:
            1. Imagen 1: Una persona.
            2. Imagen 2: Una pieza de joyería.
            
            Tu tarea es describir detalladamente cómo se vería la joya puesta en la persona. 
            Habla sobre la escala (tamaño), la caída, cómo interactúa el brillo con la piel o la ropa, 
            y la posición ideal. 
            Si el usuario dio una instrucción extra, cúmplela: ${promptUser || 'Ninguna'}.
            Sé elegante y técnico en tu lenguaje.
        `;

        // Generar contenido con ambas imágenes
        const result = await model.generateContent([
            { text: promptSistema },
            { inlineData: { data: image1, mimeType: "image/jpeg" } },
            { inlineData: { data: image2, mimeType: "image/jpeg" } }
        ]);

        const response = await result.response;
        const text = response.text();

        res.json({ success: true, result: text });

    } catch (error) {
        console.error("❌ Error en el proceso:", error);
        res.status(500).json({ 
            success: false, 
            error: "Error en la IA: " + error.message 
        });
    }
});

// --- CONFIGURACIÓN DEL PUERTO ---
// Koyeb usa un puerto dinámico, por eso usamos process.env.PORT
const PORT = process.env.PORT || 8000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor listo en el puerto ${PORT}`);
});


