/**
 * src/routes/triage.js — Asistente de triaje veterinario de síntomas con Gemini IA
 *
 * Recopila el contexto clínico de la mascota (especie, edad, peso, alergias y
 * medicamentos activos) y consulta `gemini-2.5-flash` exigiendo JSON estricto
 * para alternar preguntas guiadas y emitir un dictamen con semáforo de urgencia
 * (`verde`, `ambar`, `rojo`). Incluye modo simulacro cuando falta clave o cuota.
 */
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { requireAuth } from '../middleware/auth.js';
import pool from '../config/database.js';

const router = express.Router();

/**
 * Inicializa el cliente oficial de Google Gemini si existe `GEMINI_API_KEY` válida.
 */
const getGeminiClient = () => {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key || key.includes('your_')) return null;
  return new GoogleGenAI({ apiKey: key });
};

/**
 * POST /api/triage/:petId
 * Evalúa los síntomas descritos por el usuario usando Google Gemini (`gemini-2.5-flash`).
 * Body: `{ conversation: [{role, content}], current_symptoms_summary: string }`
 */
router.post('/:petId', requireAuth, async (req, res) => {
  const { petId } = req.params;
  const { conversation = [], current_symptoms_summary = '' } = req.body;

  if (!conversation.length && !current_symptoms_summary) {
    return res.status(400).json({ error: 'Se requiere al menos una descripción de síntomas.' });
  }

  let pet;
  try {
    const petResult = await pool.query(
      `SELECT m.id, m.nombre AS name, m.especie AS species, m.raza AS breed,
              m.peso_kg AS weight_kg, m.fecha_nacimiento AS birthdate,
              m.alergias_conocidas AS known_allergies, m.condiciones_cronicas AS chronic_conditions,
              COALESCE(array_agg(DISTINCT t.medicamento) FILTER (WHERE t.estado='active'), '{}') AS active_meds
       FROM mascotas m
       LEFT JOIN tratamientos t ON t.mascota_id = m.id AND t.estado = 'active'
       WHERE m.id = $1 AND m.dueno_id = $2
       GROUP BY m.id`,
      [petId, req.user.id]
    );

    if (!petResult.rows.length) {
      return res.status(404).json({ error: 'Mascota no encontrada o no tienes acceso.' });
    }

    pet = petResult.rows[0];
    const birthdate = pet.birthdate ? new Date(pet.birthdate) : null;
    const ageMonths = birthdate
      ? Math.floor((Date.now() - birthdate.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
      : null;
    const ageStr = ageMonths
      ? (ageMonths < 12 ? `${ageMonths} meses` : `${Math.floor(ageMonths / 12)} años`)
      : 'edad desconocida';

    const speciesMap = { dog: 'perro', cat: 'gato', rabbit: 'conejo', bird: 'ave', reptile: 'reptil', other: 'mascota' };
    const speciesLabel = speciesMap[pet.species] || pet.species;

    const allergies = Array.isArray(pet.known_allergies)
      ? pet.known_allergies.filter(Boolean).join(', ')
      : (pet.known_allergies || 'ninguna conocida');

    const meds = Array.isArray(pet.active_meds) && pet.active_meds.filter(Boolean).length
      ? pet.active_meds.filter(Boolean).join(', ')
      : 'ninguno';

    const systemPrompt = `Eres PetCare IA, un asistente empático y altamente profesional, especializado en triaje veterinario de primer nivel.
Tu objetivo es ayudar a los dueños a evaluar los síntomas que presentan sus mascotas, determinando el nivel de urgencia para buscar atención veterinaria.
NUNCA diagnostiques enfermedades específicas ni recomiendes medicamentos, tu meta es brindar orientación segura y dictaminar un nivel de urgencia.

DATOS DEL PACIENTE:
- Nombre: ${pet.name}
- Especie: ${speciesLabel}
- Raza: ${pet.breed || 'desconocida'}
- Edad: ${ageStr}
- Peso: ${pet.weight_kg ? pet.weight_kg + ' kg' : 'desconocido'}
- Alergias: ${allergies}
- Medicación: ${meds}
- Condiciones: ${pet.chronic_conditions || 'ninguna conocida'}

INSTRUCCIONES DE INTERACCIÓN:
1. Comunícate en un tono profesional, compasivo y cálido. Llama a la mascota por su nombre (${pet.name}).
2. Si la información es escasa, realiza preguntas clave (sobre tiempo de evolución, apetito, energía, etc.) para entender mejor el caso.
3. Una vez que tengas un cuadro claro (usualmente 2-3 intercambios de información), clasifica la urgencia.
   - VERDE: Situación no urgente, comportamental o muy leve (ej. aburrimiento, no quiere jugar, un estornudo aislado). Puede sugerirse observación en casa.
   - AMBAR: Situación de cuidado, se aconseja valoración veterinaria hoy.
   - ROJO: Emergencia médica, requiere atención veterinaria INMEDIATA.

FORMATOS DE RESPUESTA (Debes devolver ÚNICAMENTE JSON válido, sin bloques markdown como \`\`\`json):

CASO A - Si necesitas más detalles (modo interactivo):
{
  "tipo": "pregunta",
  "texto": "Tu respuesta empática y tu siguiente pregunta en lenguaje natural, clara y profesional.",
  "opciones": ["Opción 1", "Opción 2", "Opción 3", "Opción 4"]
}

CASO B - Si ya tienes suficiente información para dictaminar:
{
  "tipo": "resultado",
  "nivel_urgencia": "verde" | "ambar" | "rojo",
  "titulo": "Evaluación: [Resumen corto del cuadro]",
  "razon": "Explicación clara y profesional de tu evaluación dirigida al dueño. Termina recordando que esta asesoría no sustituye la visita a un Médico Veterinario.",
  "sintomas_detectados": ["síntoma 1", "síntoma 2"],
  "pasos_recomendados": ["1. Acción inmediata y segura", "2. Monitorización", "3. Acudir al veterinario"],
  "senal_alarma": "Qué signos adicionales deberían obligar a ir a urgencias de inmediato."
}

REGLA CRÍTICA: Tú NO produces texto fuera del JSON. La respuesta debe ser puramente el objeto JSON para poder ser procesada por el sistema.`;

    const contents = [];
    if (current_symptoms_summary) {
      contents.push({
        role: 'user',
        parts: [{ text: `Síntomas de ${pet.name}: ${current_symptoms_summary}` }],
      });
    }

    conversation.forEach(msg => {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    });

    const ai = getGeminiClient();
    if (!ai) {
      return simulateAIResponse(pet, conversation, res);
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: { systemInstruction: systemPrompt },
    });

    const rawContent = response.text || '{}';

    let parsed;
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No se encontró JSON en la respuesta');
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error('Error parseando respuesta de Gemini:', rawContent);
      parsed = {
        tipo: 'pregunta',
        texto: `¿Cuáles son los síntomas principales que estás observando en ${pet.name}?`,
        opciones: [
          'Vómito o diarrea',
          'Letargo o desgano',
          'No come ni bebe',
          'Dificultad para respirar',
        ],
      };
    }

    res.json({
      success: true,
      pet_name: pet.name,
      response: parsed,
    });
  } catch (err) {
    console.error('Error en triaje:', err.message || err);

    if ([400, 401, 403, 429].includes(err.status)) {
      console.warn('API de Gemini no disponible (Auth o Límite). Activando modo simulacro.');
      if (pet) {
        return simulateAIResponse(pet, conversation, res, true);
      }
    }

    res.status(500).json({ error: 'Error al procesar el triaje: ' + err.message });
  }
});

/**
 * Simula respuestas estructuradas de triaje cuando falta API Key o se alcanza el límite de cuota.
 */
function simulateAIResponse(pet, conversation, res, isKeyError = false) {
  const count = conversation.length;
  const prefix = isKeyError ? '*(Nota: Usando modo de prueba por error en API Key)*\n\n' : '';
  let parsed;

  if (count < 2) {
    parsed = {
      tipo: 'pregunta',
      texto: prefix + `Hola, soy el asistente de PetCare. He notado que quieres evaluar a ${pet.name}. ¿Qué es lo primero que has notado fuera de lo normal?`,
      opciones: ['Cambios en el apetito', 'Nivel de energía bajo', 'Vómito o Diarrea', 'Problemas al caminar'],
    };
  } else if (count < 4) {
    parsed = {
      tipo: 'pregunta',
      texto: `Entiendo. Respecto a eso, ¿hace cuánto tiempo se presenta y has notado algún otro síntoma como fiebre o decaimiento en ${pet.name}?`,
      opciones: ['Hace unas horas', 'Desde ayer', 'Varios días', 'Empezó hoy'],
    };
  } else {
    parsed = {
      tipo: 'resultado',
      nivel_urgencia: 'ambar',
      titulo: 'Atención Veterinaria Hoy',
      razon: `*(Modo de Prueba Activado)* ${pet.name} presenta síntomas simulados que sugieren un malestar moderado. Es recomendable una revisión.`,
      sintomas_detectados: ['Decaimiento', 'Síntomas generales simulados'],
      pasos_recomendados: [
        'Monitorea su temperatura si es posible',
        'Asegúrate de que tenga agua fresca disponible',
        'Llévalo a consulta con su MVZ el día de hoy',
      ],
      senal_alarma: 'Si comienza a respirar con dificultad o no puede sostenerse en pie, ve a urgencias inmediatamente.',
    };
  }

  return res.json({
    success: true,
    pet_name: pet.name,
    response: parsed,
    mock: true,
  });
}

export default router;
