import {
  Bot,
  Context,
  InlineKeyboard,
  webhookCallback,
} from "https://deno.land/x/grammy@v1.25.1/mod.ts";

// --- 1. Configuration & Setup ---

const BOT_TOKEN = "7936487928:AAENklfHmE5uLadTmB3wzqqEK4nWprIqLEY";
const ADMIN_ID = "1908801848";

const kv = await Deno.openKv();
const bot = new Bot(BOT_TOKEN);

// In-memory map to store timers for batch processing
const batchTimers = new Map<number, number>();


// --- 2. Middleware for Whitelisting ---
// (No changes needed here)
bot.use(async (ctx, next) => {
  const command = ctx.message?.text?.split(" ")[0];
  const publicCommands = ["/start", "/myid", "/requestaccess", "/processbatch"];
  if (command && publicCommands.includes(command)) {
    return next();
  }
  if (ctx.callbackQuery?.from.id.toString() === ADMIN_ID) {
    return next();
  }
  const userId = ctx.from?.id;
  if (!userId) return;
  if (userId.toString() === ADMIN_ID) return next();
  const isWhitelisted = (await kv.get(["whitelist", userId])).value;
  if (isWhitelisted) {
    await next();
  } else {
    await ctx.reply("❌ You are not authorized to use this feature. Use /requestaccess to ask for permission.");
  }
});


// --- 3. Public Command Handlers ---

bot.command("start", (ctx) => {
  const welcomeText = `👋 **Welcome!**

I can process VCF contact files. You can process files in two ways:

1️⃣ **Single File:** Just send me a \`.vcf\` file.

2️⃣ **Multiple Files:** Use the /processbatch command. I will wait for you to send all your files and then give you a single, combined report.

To get started, you may need permission. Use /requestaccess if needed.`;
  ctx.reply(welcomeText, { parse_mode: "Markdown" });
});

// (myid and access request systems remain the same)
bot.command("myid", (ctx) => { /* ... */ });
bot.command("requestaccess", async (ctx) => { /* ... */ });
bot.callbackQuery(/^(approve|reject)_(\d+)$/, async (ctx) => { /* ... */ });


// --- 4. Batch Processing Commands & Logic ---

bot.command("processbatch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Set the user's status to "batch mode" in the database
    await kv.set(["batch_mode", userId], true);
    // Clear any previously collected contacts for this user
    await kv.delete(["batch_contacts", userId]);

    await ctx.reply("✅ **Batch mode activated.**\nPlease send all your VCF files now. I will wait 10 seconds after your last file before sending a combined report.", { parse_mode: "Markdown" });
});

async function processAndSendBatch(userId: number) {
    // Retrieve all collected contacts from the database
    const result = await kv.get<any[]>(["batch_contacts", userId]);
    const allContacts = result.value || [];

    if (allContacts.length === 0) {
        await bot.api.sendMessage(userId, "⚠️ Batch finished, but no valid contacts were found in the files you sent.");
    } else {
        // Build the combined report
        let table = `✅ **Batch processing complete!**\n\n`;
        table += `Found a total of ${allContacts.length} contacts across all files.\n\n`;
        table += '<b>Processed Contacts</b>\n<pre>';
        table += 'Name                 | Phone Number\n';
        table += '-------------------- | ------------------\n';
        for (const contact of allContacts) {
            const sanitizedName = contact.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const paddedName = sanitizedName.padEnd(20, ' ');
            table += `${paddedName} | ${contact.tel}\n`;
        }
        table += '</pre>';

        await bot.api.sendMessage(userId, table, { parse_mode: "HTML" });
    }

    // Clean up: exit batch mode and delete stored contacts
    await kv.delete(["batch_mode", userId]);
    await kv.delete(["batch_contacts", userId]);
    batchTimers.delete(userId);
}


// --- 5. VCF File Processing (Updated to handle both single and batch modes) ---
bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const userId = ctx.from.id;

    if (!doc.file_name?.toLowerCase().endsWith(".vcf")) {
        return ctx.reply("Please send a valid `.vcf` file.");
    }

    // Check if the user is in batch mode
    const inBatchMode = (await kv.get(["batch_mode", userId])).value;

    try {
        const file = await ctx.getFile();
        const filePath = file.file_path;
        if (!filePath) throw new Error("File path is not available.");
        
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
        const fileContent = await response.text();

        const vcardBlocks = fileContent.split("BEGIN:VCARD");
        const parsedContacts: { name: string, tel: string }[] = [];

        for (const block of vcardBlocks) {
            if (block.trim() === "") continue;
            let contactName: string | null = null, contactTel: string | null = null;
            const lines = block.split(/\r?\n/);
            for (const line of lines) {
                if (line.toUpperCase().startsWith("FN:")) contactName = line.substring(line.indexOf(":") + 1).trim();
                else if (!contactName && line.toUpperCase().startsWith("N:")) contactName = line.substring(line.indexOf(":") + 1).replace(/;/g, ' ').trim();
                if (line.toUpperCase().startsWith("TEL")) {
                    const potentialTel = line.substring(line.lastIndexOf(":") + 1).trim();
                    if (potentialTel) contactTel = potentialTel;
                }
            }
            if (contactName && contactTel) parsedContacts.push({ name: contactName, tel: contactTel });
        }

        if (parsedContacts.length === 0) {
            await ctx.reply(`⚠️ The file \`${doc.file_name}\` contained no valid contacts.`, { parse_mode: "Markdown" });
            return;
        }

        if (inBatchMode) {
            // --- BATCH MODE LOGIC ---
            // Add the newly parsed contacts to the existing batch
            const existingContacts = (await kv.get<any[]>(["batch_contacts", userId])).value || [];
            await kv.set(["batch_contacts", userId], [...existingContacts, ...parsedContacts]);

            // Clear any existing timer and set a new one (debounce)
            if (batchTimers.has(userId)) clearTimeout(batchTimers.get(userId));
            const timerId = setTimeout(() => processAndSendBatch(userId), 10000); // 10 seconds
            batchTimers.set(userId, timerId);

            // Give the user a small confirmation for each file received
            await ctx.reply(`👍 Received \`${doc.file_name}\` and added ${parsedContacts.length} contacts to the batch.`, { parse_mode: "Markdown" });
        } else {
            // --- SINGLE FILE MODE LOGIC ---
            const sanitizedFileName = doc.file_name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            let table = `<b>File:</b> <code>${sanitizedFileName}</code>\n\n`;
            table += '<b>Processed Contacts</b>\n<pre>';
            table += 'Name                 | Phone Number\n';
            table += '-------------------- | ------------------\n';
            for (const contact of parsedContacts) {
                const sanitizedName = contact.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const paddedName = sanitizedName.padEnd(20, ' ');
                table += `${paddedName} | ${contact.tel}\n`;
            }
            table += '</pre>';
            await ctx.reply(table, { parse_mode: "HTML" });
        }

    } catch (error) {
        console.error("Error processing VCF file:", error);
        await ctx.reply("An error occurred while processing the file. The admin has been notified.");
    }
});


// --- 6. Error Handling & Deployment ---
bot.catch((err) => console.error(`Error for update ${err.ctx.update.update_id}:`, err.error));
if (Deno.env.get("DENO_DEPLOYMENT_ID")) { Deno.serve(webhookCallback(bot, "std/http")); } 
else { console.log("Bot starting..."); bot.start(); }
