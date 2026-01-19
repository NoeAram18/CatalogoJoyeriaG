const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI('AIzaSyB6hJkpVVEg6C3INWaVm2F3OgJk9-QhS0M');

async function test() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Hola");
        console.log("✅ TU LLAVE FUNCIONA:", result.response.text());
    } catch (e) {
        console.error("❌ TU LLAVE NO TIENE PERMISO:", e.message);
    }
}
test();