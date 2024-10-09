const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const axios = require('axios');
const cheerio = require('cheerio');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');
const { encode, decode } = require('gpt-3-encoder');
require('dotenv').config();

// Your OpenAI API key
const API_KEY = process.env.CHATGPT_API_KEY;

// If modifying these scopes, delete token.json.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets'
];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const SHEET_ID = '1Qow5FXrEEcsv8DJwySODvLwcJ434h9gXyJu7Jyg6Tu0';
const SHEET_NAME = 'Responses'; // Modify if your sheet name is different

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

/**
 * Ensures that the URL starts with 'https://'.
 * @param {string} url The URL to check.
 * @return {string} The corrected URL.
 */
function ensureHttps(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `https://${url}`;
    }
    return url;
  }

/**
 * Cleans up text content by removing extra spaces and new lines, and replacing them with tabs.
 * @param {string} text The text content to clean up.
 * @return {string} The cleaned text content.
 */
function cleanTextContent(text) {
    return text
      .replace(/\s{2,}/g, '\t') // Replace multiple spaces with a tab
      .replace(/\n+/g, '\t') // Replace new lines with a tab
      .trim(); // Trim leading and trailing whitespace
}

function estimateTokenCount(text) {
  return encode(text).length; // Uses the encoder to get the accurate token count
}


/**
 * Sends a request to ChatGPT and returns the response.
 *
 * @param {string} prompt - The prompt to send to ChatGPT.
 * @param {string} apiKey - Your OpenAI API key.
 * @return {Promise<string>} - The response from ChatGPT.
 */
async function getChatGPTResponse(prompt, apiKey) {
  console.log('Sending prompt to ChatGPT');

  // Check the token count
  const tokenCount = estimateTokenCount(prompt);
  const maxTokens = 128000; // Adjust as needed

  if (tokenCount > maxTokens) {
      console.warn(`Prompt exceeds the maximum token limit of ${maxTokens}. Truncating...`);
      const encodedPrompt = encode(prompt);
      const maxEncodedLength = maxTokens - 30000; // Leave space for response tokens
      const truncatedPrompt = decode(encodedPrompt.slice(0, maxEncodedLength));
      prompt = truncatedPrompt;
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
  };
  const data = {
      model: 'gpt-4o-mini', // Updated to use GPT-4-turbo
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096, // Adjust token count as needed
  };

  while (true) {
      try {
          const response = await axios.post(url, data, { headers });
          return response.data.choices[0].message.content.trim();
      } catch (error) {
          if (error.response && error.response.data.error.code === 'rate_limit_exceeded') {
              // Extract wait time from the error message
              const message = error.response.data.error.message;
              const match = message.match(/try again in (\d+(\.\d+)?)s/);
              if (match) {
                  const waitTime = parseFloat(match[1]);
                  console.warn(`Rate limit exceeded. Waiting for ${waitTime} seconds before retrying...`);
                  await new Promise(resolve => setTimeout(resolve, waitTime * 1000)); // Wait for the specified time
              } else {
                  // If we can't find the wait time, log and throw an error
                  console.error('Error communicating with ChatGPT:', message);
                  throw error;
              }
          } else {
              console.error('Error communicating with ChatGPT:', error.response ? error.response.data : error.message);
              throw error; // Rethrow for other types of errors
          }
      }
  }
}


// Function to update Google Sheets data
async function updateGoogleSheet(sheets, spreadsheetId, range, value) {
    const updateData = {
      range: range,
      values: [[value]],
    };
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: range,
      valueInputOption: 'RAW',
      resource: updateData,
    });
  }

function truncateTo80Chars(text) {
  if (text.length <= 80) return text;
  const truncated = text.slice(0, 80);
  return truncated.slice(0, Math.max(truncated.lastIndexOf(' '), 0)) + "...";
}

async function processRow(sheets, rowIndex, row, websiteSummaryPrompt, leadQualityPrompt, craftEmailPrompt, craftSubjectPrompt) {
  const firstName = row[0] || 'N/A'; // Column D (Index 0)
  const lastName = row[1] || 'N/A';  // Column E (Index 1)
  const companyName = row[2] || 'N/A'; // Column H (Index 4)
  const companyWebsite = row[3] || 'N/A'; // Column L (Index 8)
  const linkedinInfo = row[4] || 'N/A'; // Column M (Index 9)
  const emailSubject = row [6] || 'N/A'
  const emailContent = row[7] || 'N/A'; // Column P (Index 12)
  const leadType = row[14] || 'N/A'; // Column R (Index 14)

  const fullUrl = ensureHttps(companyWebsite);
  console.log(emailSubject, emailContent);

  if (companyWebsite !== "N/A" && emailContent === "N/A") {
      try {
          // Fetch website content
          console.log('Generating Email - Fetching Website Content:', fullUrl);
          const response = await axios.get(fullUrl);
          const html = response.data;
          const $ = cheerio.load(html);
          const textContent = cleanTextContent($('body').text());

          console.log('Fetched Content');
          
          
          // Prepare ChatGPT requests
          const websiteSummaryResponse = await getChatGPTResponse(websiteSummaryPrompt.replace('{{content}}', textContent), API_KEY);
          const linkedInFullInfo = `${firstName} ${lastName} from ${companyName}: ${linkedinInfo}`;

          const leadQualityResponse = await getChatGPTResponse(leadQualityPrompt.replace('{{summary}}', websiteSummaryResponse), API_KEY);
          const emailResponse = await getChatGPTResponse(craftEmailPrompt.replace('{{summary}}', websiteSummaryResponse).replace('{{linkedin}}', linkedInFullInfo), API_KEY);
          const subjectResponse = await getChatGPTResponse(craftSubjectPrompt.replace('{{email}}', emailResponse), API_KEY);

          // Update Google Sheet with the lead quality response in column R and email response in column P
          const leadQualityRange = `${SHEET_NAME}!I${rowIndex + 2}`;
          const emailRange = `${SHEET_NAME}!H${rowIndex + 2}`;
          const subjectRange = `${SHEET_NAME}!G${rowIndex + 2}`;

          await updateGoogleSheet(sheets, SHEET_ID, leadQualityRange, leadQualityResponse);
          await updateGoogleSheet(sheets, SHEET_ID, emailRange, emailResponse);
          await updateGoogleSheet(sheets, SHEET_ID, subjectRange, subjectResponse);

          // Log responses
          console.log('Website Summary Response:', truncateTo80Chars(websiteSummaryResponse));
          console.log('Lead Quality Response:', truncateTo80Chars(leadQualityResponse));
          console.log('Crafted Email Response:', truncateTo80Chars(emailResponse));
      } catch (err) {
          console.error(`Error processing row ${rowIndex + 2}:`, err.message);
      }
  } else if (companyWebsite !== "N/A" && leadType === "N/A") {
      try {
          // Fetch website content
          console.log('Generating lead - Fetching Website Content:', fullUrl);
          const response = await axios.get(fullUrl);
          const html = response.data;
          const $ = cheerio.load(html);
          const textContent = cleanTextContent($('body').text());

          console.log('Fetched Content');
          
          // Prepare ChatGPT requests
          await delay(50);
          const websiteSummaryResponse = await getChatGPTResponse(websiteSummaryPrompt.replace('{{content}}', textContent), API_KEY);
          await delay(50);
          const leadQualityResponse = await getChatGPTResponse(leadQualityPrompt.replace('{{summary}}', websiteSummaryResponse), API_KEY);
          // Update Google Sheet with the lead quality response in column R and email response in column P
          const leadQualityRange = `${SHEET_NAME}!I${rowIndex + 2}`;

          await updateGoogleSheet(sheets, SHEET_ID, leadQualityRange, leadQualityResponse);

          // Log responses
          console.log('Website Summary Response:', truncateTo80Chars(websiteSummaryResponse));
          console.log('Lead Quality Response:', truncateTo80Chars(leadQualityResponse));
      } catch (err) {
          console.error(`Error processing row ${rowIndex + 2}:`, err.message);
      }
}

}

/**
 * Fetches and logs data from the Google Sheet.
 * @param {OAuth2Client} authClient An authorized OAuth2 client.
 */
async function fetchSheetData(authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
      const range = `Prompts!2:2`; // Row 4
      const promptRes = await sheets.spreadsheets.values.get({
          spreadsheetId: "1Qow5FXrEEcsv8DJwySODvLwcJ434h9gXyJu7Jyg6Tu0",
          range: range,
      });

      const row = promptRes.data.values ? promptRes.data.values[0] : [];

      // Extract specific columns
      const websiteSummaryPrompt = row[0] || 'N/A'; // Column F (Index 5)
      const leadQualityPrompt = row[1] || 'N/A'; // Column G (Index 6)
      const craftEmailPrompt = row[2] || 'N/A'; // Column H (Index 7)
      const craftSubjectPrompt = row[3] || 'N/A'; // Column I (Index 8)

      console.log(websiteSummaryPrompt,leadQualityPrompt, craftEmailPrompt);

      // Get data from row 2 onward
      const dataRange = `${SHEET_NAME}!A2:I`; // Adjust range as needed
      const res = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: dataRange,
      });

      const rows = res.data.values || [];
      let chunkSize = 20; // Initial chunk size
      console.log(rows);

      for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const promises = chunk.map((row, rowIndex) => {
              return processRow(sheets, i + rowIndex, row, websiteSummaryPrompt, leadQualityPrompt, craftEmailPrompt, craftSubjectPrompt)
                  .catch(error => {
                      console.error(`Error processing row ${i + rowIndex + 2}:`, error.message);
                      return null; // Return null to signify failure
                  });
          });

          const results = await Promise.all(promises); // Wait for all promises in this chunk to finish

          // Check if any row failed
          const failedRowIndices = results.map((result, index) => (result === null ? i + index : null)).filter(index => index !== null);
          if (failedRowIndices.length > 0) {
              console.log(`Errors occurred in rows: ${failedRowIndices.join(', ')}. Adjusting chunk size...`);
              chunkSize = Math.max(1, failedRowIndices[0] - i); // Adjust chunk size based on the first failed row
              console.log(`Reprocessing chunk starting from row ${i + 2} to ${i + chunkSize + 1}.`);
              i -= chunkSize; // Go back to reprocess the previous chunk
          } else {
              if (i + chunkSize < rows.length) {
                  console.log(`Processed chunk ${Math.floor(i / chunkSize) + 1}. Waiting for 1 second...`);
                  await new Promise(resolve => setTimeout(resolve, 10)); // Wait for 1 minute
              }
          }
      }

      console.log("Finished processing all chunks");
  } catch (err) {
      console.error('Error fetching sheet data:', err);
  }
}


authorize().then(fetchSheetData).catch(console.error);
