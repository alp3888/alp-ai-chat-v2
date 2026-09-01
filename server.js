const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error('【エラー】GEMINI_API_KEY が設定されていません。');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SPREADSHEET_CSV_URL = process.env.SPREADSHEET_CSV_URL;

// カンマ区切りCSVを正確に分解する関数（引用符対応）
function parseCSVLine(text) {
  const result = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cell.trim());
      cell = '';
    } else {
      cell += c;
    }
  }
  result.push(cell.trim());
  return result;
}

// スプレッドシート（CSV）からFAQデータを自動読み込み
async function fetchSpreadsheetFAQ() {
  try {
    if (!SPREADSHEET_CSV_URL) {
      return '（現在、参照用スプレッドシートデータは未設定です）';
    }
    const res = await fetch(SPREADSHEET_CSV_URL);
    const csvText = await res.text();

    const lines = csvText.split(/\r?\n/);
    let faqPrompt = '【絶対遵守：最新FAQ・個別回答ナレッジベース（スプレッドシート連動）】\n';
    faqPrompt += '※以下のキーワードに関連する質問を受けた場合は、一般論で濁さず、指定された回答方針に従って明確かつ断定的に回答してください。\n\n';

    // 2行目以降を順次取得
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const row = parseCSVLine(lines[i]);
      const category = row[0] || '';
      const keyword = row[1] || '';
      const instruction = row[2] || '';
      const ng = row[3] || '';

      if (keyword && instruction) {
        const catText = category ? `[${category}] ` : '';
        faqPrompt += `- ${catText}対象キーワード/質問:「${keyword}」\n  回答・指示方針: ${instruction}\n  NG表現・不可事項: ${ng || 'なし'}\n\n`;
      }
    }
    return faqPrompt;
  } catch (error) {
    console.error('スプレッドシート読み込みエラー:', error);
    return '（FAQデータの読み込みに一時的に失敗しました）';
  }
}

// 指示文の構築関数
async function buildSystemInstruction() {
  const dynamicFAQ = await fetchSpreadsheetFAQ();

  return `
あなたは「アドバンスライフプランニング株式会社（https://www.alp-support.co.jp）」の対話型AIコンシェルジュです。

【当社の本来の強み・事業内容】
高齢者向け終身サポート（身元保証、財産管理、遺言・死後事務委任、施設入居支援、自宅売却・空き家対策等の一括サポート）。

【配慮すべき言葉遣い・NGマナー】
- 施設への入居、ご自宅の手放し、身元保証のご相談等に対して、「おめでとうございます」などの安易な祝い言葉は【絶対NG】です。
- 住み慣れた自宅を離れる葛藤や不安、複雑な心境に寄り添い、「大きなご決断ですね」「様々なご不安やお悩みが合わさる時期かと存じます」と丁寧な共感・傾聴を徹底してください。

${dynamicFAQ}

【対話の目的とターゲット誘導】
1. 最優先ターゲット（OWNER_LEAD）：
   「持ち家（戸建て・分譲マンション）」をお持ちで、今後の「終活・身元保証・遺言・施設入居に伴う自宅の整理処分」等にお悩みの方。
   ★施設入居の話題が出た場合の導線：
     施設入居には「身元保証人」と「空き家となるご自宅の管理・売却・片付け」の2つの課題が同時に発生します。
     AIは「施設入居時の身元保証から、ご自宅（持ち家）の処分・整理まで当社で一括してお手伝いできること」をお伝えし、不安を和らげた上で、4〜6ターンを目安にご相談窓口（連絡先フォーム）へ案内してください。

2. その他のご相談者（OTHER_COMPLETE）：
   賃貸にお住まいの方や、持ち家でも終活以外の一般相談の方。
   → 無理に排除せず、親身にお話を聞いた上で、「地域包括支援センター」や「社会福祉協議会」など適切な公的窓口をアドバイスして対話を完結させてください。

3. 営業・売り込み（SPAM_REJECT）：
   丁寧にお断りして終了してください。

【出力フォーマット】
必ず以下のJSON形式のみで出力してください：
{
  "message": "ユーザーへの返信テキスト",
  "status": "CONTINUE" | "OWNER_LEAD" | "OTHER_COMPLETE" | "SPAM_REJECT",
  "summary": "OWNER_LEADの場合のご相談要約と持ち家状況（その他はnull）"
}
`;
}

// 呼び出し（リトライ付き）
async function generateWithRetry(model, promptText, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await model.generateContent(promptText);
    } catch (err) {
      if (err.status === 429 || i === retries) throw err;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { history, userMessage } = req.body;
    const systemInstruction = await buildSystemInstruction();

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const promptText = `
${systemInstruction}

【これまでの対話履歴】
${history ? history.map(h => `${h.role}: ${h.text}`).join('\n') : ''}

【ユーザーの最新の発言】
user: ${userMessage}
`;

    const result = await generateWithRetry(model, promptText);
    const responseText = result.response.text();
    const responseData = JSON.parse(responseText);

    res.json(responseData);
  } catch (error) {
    console.error('API Error Detail:', error);
    res.status(500).json({ error: '通信エラーが発生しました。' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
