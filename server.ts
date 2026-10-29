import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const DATA_FILE = path.join(__dirname, 'cbt_database.json');

  app.use(express.json({ limit: '50mb' }));

  // Gemini Client Initialization with telemetry header
  const apiKey = process.env.GEMINI_API_KEY;
  let ai: GoogleGenAI | null = null;
  if (apiKey) {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  const DEMO_TEACHER_USERNAMES = new Set([
    'guru_bahasa',
    'guru_ips',
    'guru_pai',
    'guru_pkn',
    'guru_akl',
    'guru_dkv',
    'guru1',
    'guru_indo',
    'guru_mtk',
    'guru_ipa',
    'guru_bing',
    'guru_bindo',
    'guru_rpl',
    'guru_tkj',
    'guru_tkr',
  ]);

  function sanitizeTeachersData(dataObj: any) {
    if (!dataObj || typeof dataObj !== 'object') return dataObj;
    if (Array.isArray(dataObj.teachers)) {
      dataObj.teachers = dataObj.teachers.filter(
        (t: any) =>
          t &&
          t.username &&
          !DEMO_TEACHER_USERNAMES.has(t.username.toLowerCase()) &&
          !(t.username.toLowerCase() === 'guru_bahasa' || (t.name || '').toLowerCase().includes('rahman spd'))
      );
    }
    if (dataObj.teacherCredentials && typeof dataObj.teacherCredentials === 'object') {
      DEMO_TEACHER_USERNAMES.forEach((uname) => {
        delete dataObj.teacherCredentials[uname];
        delete dataObj.teacherCredentials[uname.toLowerCase()];
      });
    }
    return dataObj;
  }

  // Get current shared data
  app.get('/api/cbt-data', (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = sanitizeTeachersData(JSON.parse(raw));
        return res.json({ success: true, data: parsed });
      } catch (err) {
        console.error('Error reading data file', err);
      }
    }
    return res.json({ success: false, data: null });
  });

  // Save/sync shared data with strict role authority & exam protection
  app.post('/api/cbt-data', (req, res) => {
    try {
      const { data } = req.body;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid data format' });
      }

      const sanitizedIncoming = sanitizeTeachersData(data);

      // Check existing database file
      let existingData: any = null;
      if (fs.existsSync(DATA_FILE)) {
        try {
          const raw = fs.readFileSync(DATA_FILE, 'utf-8');
          existingData = sanitizeTeachersData(JSON.parse(raw));
        } catch (e) {
          console.error('Error reading existing data file', e);
        }
      }

      // SECURITY & SYNC AUTHORITY RULE:
      // If client is a STUDENT, NEVER let them overwrite exams, bankQuestions, teachers, or teacherCredentials!
      const isTeacherOrAdmin =
        sanitizedIncoming.currentUser?.role === 'guru' ||
        Boolean(sanitizedIncoming.currentUser?.isAdmin) ||
        (sanitizedIncoming.currentUser?.username || '').toLowerCase() === 'sohibul';

      if (!isTeacherOrAdmin && existingData) {
        // Safe student update: Only merge submissions and ongoingSessions!
        const existingSubmissions = Array.isArray(existingData.submissions) ? existingData.submissions : [];
        const incomingSubmissions = Array.isArray(sanitizedIncoming.submissions) ? sanitizedIncoming.submissions : [];
        const subMap = new Map();
        existingSubmissions.forEach((s: any) => subMap.set(s.id, s));
        incomingSubmissions.forEach((s: any) => subMap.set(s.id, s));

        const mergedOngoing = {
          ...(existingData.ongoingSessions || {}),
          ...(sanitizedIncoming.ongoingSessions || {}),
        };

        const safeMergedData = sanitizeTeachersData({
          ...existingData,
          submissions: Array.from(subMap.values()),
          ongoingSessions: mergedOngoing,
        });

        fs.writeFileSync(DATA_FILE, JSON.stringify(safeMergedData, null, 2), 'utf-8');
        return res.json({ success: true, message: 'Student submissions safely recorded' });
      }

      // If client is a TEACHER or Admin:
      // Merge with existing submissions so student results are NEVER lost,
      // but give full authoritative control over exams, bank questions, and teachers to the teacher.
      let finalData = sanitizedIncoming;
      if (existingData) {
        const existingSubmissions = Array.isArray(existingData.submissions) ? existingData.submissions : [];
        const incomingSubmissions = Array.isArray(sanitizedIncoming.submissions) ? sanitizedIncoming.submissions : [];
        const subMap = new Map();
        existingSubmissions.forEach((s: any) => subMap.set(s.id, s));
        incomingSubmissions.forEach((s: any) => subMap.set(s.id, s));

        const mergedOngoing = {
          ...(existingData.ongoingSessions || {}),
          ...(sanitizedIncoming.ongoingSessions || {}),
        };

        finalData = sanitizeTeachersData({
          ...sanitizedIncoming,
          submissions: Array.from(subMap.values()),
          ongoingSessions: mergedOngoing,
        });
      }

      fs.writeFileSync(DATA_FILE, JSON.stringify(finalData, null, 2), 'utf-8');
      return res.json({ success: true, message: 'Data synced successfully' });
    } catch (err) {
      console.error('Error writing data file', err);
      return res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Dedicated endpoint for submitting exam results from students without touching exams or bank
  app.post('/api/submissions', (req, res) => {
    try {
      const { submission } = req.body;
      if (!submission || !submission.id) {
        return res.status(400).json({ success: false, message: 'Invalid submission data' });
      }

      let currentData: any = {};
      if (fs.existsSync(DATA_FILE)) {
        try {
          currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        } catch {}
      }

      const existingSubs = Array.isArray(currentData.submissions) ? currentData.submissions : [];
      const updatedSubs = [submission, ...existingSubs.filter((s: any) => s.id !== submission.id)];

      const ongoingSessions = currentData.ongoingSessions || {};
      if (submission.studentUsername && submission.examId) {
        delete ongoingSessions[`${submission.studentUsername}_${submission.examId}`];
      }

      currentData.submissions = updatedSubs;
      currentData.ongoingSessions = ongoingSessions;

      fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2), 'utf-8');
      return res.json({ success: true, message: 'Submission saved successfully' });
    } catch (err) {
      console.error('Error saving submission', err);
      return res.status(500).json({ success: false, error: String(err) });
    }
  });

  // AI Assistant endpoint: Generate questions or question explanations with High Thinking Mode
  app.post('/api/ai/generate-questions', async (req, res) => {
    if (!ai) {
      return res.status(503).json({
        success: false,
        error: 'Layanan AI belum dikonfigurasi dengan GEMINI_API_KEY.',
      });
    }

    const { subject, classLevel, topic, count = 3, type = 'pg' } = req.body;
    const prompt = `Anda adalah seorang guru ahli di Indonesia yang menyusun soal ujian CBT bermutu tinggi (HOTS & Berpikir Komputasional jika informatika).
Buatlah ${count} butir soal untuk mata pelajaran "${subject || 'Informatika'}", tingkat "${classLevel || 'Kelas 7'}", topik "${topic || 'Umum'}", dengan tipe soal "${type}".

Format keluaran HARUS berupa JSON array murni tanpa markdown formatting pembungkus seperti \`\`\`json.
Setiap elemen array memiliki struktur:
{
  "type": "${type}",
  "question": "teks pertanyaan lengkap",
  "options": ["Opsi A", "Opsi B", "Opsi C", "Opsi D"],
  "answer": "indeks angka 0-3 untuk pg, atau Benar/Salah untuk bs, atau kata kunci untuk isian",
  "score": 25,
  "explanation": "pembahasan singkat"
}`;

    try {
      // First attempt with gemini-4-argon with HIGH thinking level as requested
      const response = await ai.models.generateContent({
        model: 'gemini-4-argon',
        contents: prompt,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      const text = response.text || '';
      const cleanJson = text.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleanJson);
      return res.json({ success: true, questions: parsed });
    } catch (err) {
      console.warn('Gemini 4 Argon failed, falling back to gemini-3.8-flash:', err);
      try {
        const fallbackResponse = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
        });
        const text = fallbackResponse.text || '';
        const cleanJson = text.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleanJson);
        return res.json({ success: true, questions: parsed });
      } catch (fallbackErr) {
        console.error('Gemini fallback failed:', fallbackErr);
        return res.status(500).json({
          success: false,
          error: 'Gagal membuat soal dengan AI: ' + String(fallbackErr),
        });
      }
    }
  });

  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
