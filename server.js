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

// スプレッドシートデータのキャッシュ用変数（高速化対策）
let faqCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5分間キャッシュ

// カンマ区切りCSV（クォーテーション囲み対応）の分解パース関数
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

// スプレッドシート（CSV）からFAQデータを自動読み込み（キャッシュ機能付き）
async function fetchSpreadsheetFAQ() {
  const now = Date.now();
  
  // キャッシュが有効な場合は即座に前回のデータを返して通信時間を短縮
  if (faqCache && (now - lastFetchTime < CACHE_DURATION)) {
    return faqCache;
  }

  try {
    if (!SPREADSHEET_CSV_URL) {
      return '（現在、参照用スプレッドシートデータは未設定です）';
    }
    const res = await fetch(SPREADSHEET_CSV_URL);
    const csvText = await res.text();

    const lines = csvText.split(/\r?\n/);
    let faqPrompt = '【絶対遵守：最新FAQ・個別回答ナレッジベース（スプレッドシート連動）】\n';
    faqPrompt += '※以下のキーワードや質問に対しては、一般論で濁さず、指定された回答方針に従って明確かつ断定的に回答してください。\n\n';

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

    // キャッシュを更新
    faqCache = faqPrompt;
    lastFetchTime = now;
    return faqPrompt;
  } catch (error) {
    console.error('スプレッドシート読み込みエラー:', error);
    return faqCache || '（FAQデータの読み込みに一時的に失敗しました）';
  }
}

// システム指示文の構築関数
async function buildSystemInstruction() {
  const dynamicFAQ = await fetchSpreadsheetFAQ();

  return `
あなたは「アドバンスライフプランニング株式会社（https://www.alp-support.co.jp）」の対話型AIコンシェルジュです。

【当社の本来の強み・事業内容】
高齢者向け終身サポート（身元保証、財産管理、遺言・死後事務委任、施設入居支援、自宅売却・空き家対策等の一括サポート）。

【サービス対応エリアの絶対指定（判定ルール）】
1. 表向きの案内：一都三県（東京都・神奈川県・埼玉県・千葉県）
2. チャットでの実質絞り込み対象（重点エリア）：
   - 東京都：世田谷区、目黒区、渋谷区、港区、品川区、大田区、中央区、千代田区、文京区、新宿区、中野区、杉並区
   - 神奈川県：横浜市、鎌倉市、藤沢市

3. 対象外エリア（北海道・東北・中部・関西・中国・四国・九州沖縄および上記以外の地域）の対応：
   ユーザーのお住まいやご相談対象の不動産が上記対象エリア外（例：関西、福岡、北海道など）であると判明した場合は、以下のように回答して対話を終了してください。
   「大変恐れ入りますが、当社ではお客様お一人おひとりと直接お会いする手厚い対面サポートを徹底しているため、現在のサービス提供エリアを一都三県の一部地域（東京・神奈川の主要エリア等）に限定させていただいております。ご期待に沿えず誠に申し訳ございません。」
   ※ステータスは "OTHER_COMPLETE" に設定し、お問合せフォーム（OWNER_LEAD）への誘導は絶対に行わないでください。

【配慮すべき言葉遣い・NGマナー】
- 施設への入居、ご自宅の手放し、身元保証のご相談等に対して、「おめでとうございます」などの安易な祝い言葉は【絶対NG】です。
- 住み慣れた自宅を離れる葛藤や不安、複雑な心境に寄り添い、「大きなご決断ですね」「様々なご不安やお悩みが合わさる時期かと存じます」と丁寧な共感・傾聴を徹底してください。

${dynamicFAQ}

【対話の目的とターゲット誘導】
1. 最優先ターゲット（OWNER_LEAD）：
   上記「対応可能エリア」に「持ち家（戸建て・分譲マンション）」をお持ちで、今後の「終活・身元保証・遺言・施設入居に伴う自宅の整理処分」等にお悩みの方。
   ★会話・誘導のマナー：
     - ユーザーのお悩みに親身に回答し、会話の流れの中で自然にご自宅（持ち家か等）の話題が出た場合、または十分な信頼関係ができてから「ご自宅の管理や将来の処分も含めてご相談に乗れますよ」とお伝えしてください。
     - 唐突に「持ち家ですか？」と営業的に質問をぶつけるのはNGです。「もし差し支えなければ、今後のご自宅についてもお悩みがございましたか？」と前置きを添えて優しく確認してください。
     - 施設入居には「身元保証人」と「空き家となるご自宅の管理・売却・片付け」の2つの課題が同時に発生するため、一括してお手伝いできる旨をお伝えし、4〜6ターンを目安にご相談窓口（連絡先フォーム）へ案内してください。

2. その他のご相談者・エリア外（OTHER_COMPLETE）：
   対象エリア外の方、賃貸にお住まいの方、または持ち家でも終活以外の一般相談の方。
   → 無理に排除せず、親身にお話を聞いた上で、エリア外の方にはお詫びを伝え、その他の方には「地域包括支援センター」や「社会福祉協議会」など適切な公的窓口をアドバイスして対話を完結させてください。

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

// リトライ付きAPI呼出
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
