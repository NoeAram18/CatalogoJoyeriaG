require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/', (req, res) => {
    res.send('Servidor de Joyería IA funcionando correctamente ✅');
});

app.post('/procesar', async (req, res) => {
    try {
        const { image1, image2, promptUser } = req.body;

       
       // Usaremos la versión "preview" de Gemini 3 que vimos en tu panel de Google AI Studio
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const promptSistema = `
            Actúa como un motor de renderizado de joyería de alta precisión.
            Analiza la Imagen 1 (Persona) y la Imagen 2 (Joya).
            
            Tu objetivo es:
            1. Describir visualmente la joya integrada en el cuerpo de la persona.
            2. Ser extremadamente específico sobre la ubicación (ej. 'en el dedo anular de la mano derecha').
            3. Si el usuario pidió algo especial: ${promptUser || 'Ninguno'}.
            
            IMPORTANTE: Responde solo con texto descriptivo elegante. No uses formatos JSON.
        `;

        const result = await model.generateContent([
            { text: promptSistema },
            { inlineData: { data: image1, mimeType: "image/jpeg" } },
            { inlineData: { data: image2, mimeType: "image/jpeg" } }
        ]);

        const response = await result.response;
        const text = response.text();

        res.json({ success: true, result: text });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
});




