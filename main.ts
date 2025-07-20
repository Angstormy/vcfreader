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

// --- 2. Middleware for Whitelisting ---

bot.use(async (ctx, next) => {
  const command = ctx.message?.text?.split(" ")[0];
  const publicCommands = ["/start", "/myid", "/requestaccess"];
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
  const welcomeText = `👋 Welcome! I can process VCF contact files.

To get started, you need permission from the administrator.

➡️ Use the /requestaccess command to send an approval request.`;
  ctx.reply(welcomeText);
});

bot.command("myid", (ctx) => {
  const userId = ctx.from?.id;
  ctx.reply(`Your Telegram User ID is: \`${userId}\``, { parse_mode: "MarkdownV2" });
});

// --- 4. Access Request System ---

bot.command("requestaccess", async (ctx) => {
  const user = ctx.from;
  if (!user) return;
  if (user.id.toString() === ADMIN_ID || (await kv.get(["whitelist", user.id])).value) {
    return ctx.reply("✅ You are already authorized to use this bot.");
  }
  if ((await kv.get(["pending", user.id])).value) {
    return ctx.reply("⏳ Your access request is already pending. Please wait for the admin to respond.");
  }
  let userInfo = `<b>New Access Request</b>\n\n`;
  userInfo += `<b>Name:</b> ${user.first_name} ${user.last_name || ''}\n`;
  userInfo += `<b>Username:</b> @${user.username || 'N/A'}\n`;
  userInfo += `<b>User ID:</b> <code>${user.id}</code>`;
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve_${user.id}`)
    .text("❌ Reject", `reject_${user.id}`);
  try {
    await bot.api.sendMessage(ADMIN_ID, userInfo, { parse_mode: "HTML", reply_markup: keyboard });
    await kv.set(["pending", user.id], true);
    await ctx.reply("✅ Your access request has been sent to the administrator.");
  } catch (error) {
    console.error("Failed to send request to admin:", error);
    await ctx.reply("Could not send the request. The administrator might have blocked the bot.");
  }
});

bot.callbackQuery(/^(approve|reject)_(\d+)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  await kv.delete(["pending", userId]);
  let newText = ctx.callbackQuery.message?.text || "";
  if (action === "approve") {
    await kv.set(["whitelist", userId], true);
    newText += `\n\n<b>[✅ Approved by admin]</b>`;
    await bot.api.sendMessage(userId, "🎉 Your access request has been approved! You can now send VCF files.");
  } else {
    newText += `\n\n<b>[❌ Rejected by admin]</b>`;
    await bot.api.sendMessage(userId, "😔 Your access request has been denied by the administrator.");
  }
  await ctx.editMessageText(newText, { parse_mode: "HTML" });
  await ctx.answerCallbackQuery({ text: `Request ${action}d!` });
});


// --- 5. VCF File Processing Logic (Definitive Parser) ---
bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;

    if (!doc.file_name?.toLowerCase().endsWith(".vcf")) {
        return ctx.reply("Please send a valid `.vcf` file.");
    }
    await ctx.reply("⏳ Processing your VCF file...");

    try {
        const file = await ctx.getFile();
        const filePath = file.file_path;
        if (!filePath) throw new Error("File path is not available.");
        
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
        const fileContent = await response.text();

        // New, highly robust parsing method
        const contacts: { name: string, tel: string }[] = [];
        // Split the entire file into individual VCard blocks
        const vcardBlocks = fileContent.split("BEGIN:VCARD");

        for (const block of vcardBlocks) {
            if (block.trim() === "") continue;

            let contactName: string | null = null;
            let contactTel: string | null = null;

            // Split each block into lines to process it
            const lines = block.split(/\r?\n/);
            for (const line of lines) {
                // Find the name, preferring FN (Full Name) but accepting N (Name)
                if (line.toUpperCase().startsWith("FN:")) {
                    contactName = line.substring(line.indexOf(":") + 1).trim();
                } else if (!contactName && line.toUpperCase().startsWith("N:")) {
                    // Only use N if FN hasn't been found yet
                    contactName = line.substring(line.indexOf(":") + 1).replace(/;/g, ' ').trim();
                }
                
                // Find the telephone number, ensuring it's not empty
                if (line.toUpperCase().startsWith("TEL")) {
                    const potentialTel = line.substring(line.lastIndexOf(":") + 1).trim();
                    if (potentialTel) { // Only assign if it's not an empty string
                        contactTel = potentialTel;
                    }
                }
            }
            
            // If we successfully found both a name and a number, save the contact
            if (contactName && contactTel) {
                contacts.push({ name: contactName, tel: contactTel });
            }
        }

        if (contacts.length === 0) {
            return ctx.reply("Could not find any valid contacts. Please ensure each contact in the VCF file has both a name (FN: or N:) and a phone number (TEL:).");
        }

        let table = '<b>Processed Contacts</b>\n<pre>';
        table += 'Name                 | Phone Number\n';
        table += '-------------------- | ------------------\n';
        for (const contact of contacts) {
            const sanitizedName = contact.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const paddedName = sanitizedName.padEnd(20, ' ');
            table += `${paddedName} | ${contact.tel}\n`;
        }
        table += '</pre>';

        await ctx.reply(table, { parse_mode: "HTML" });

    } catch (error) {
        console.error("Error processing VCF file:", error);
        await ctx.reply("An error occurred while processing the file. The admin has been notified.");
    }
});


// --- 6. Error Handling & Deployment ---
bot.catch((err) => console.error(`Error for update ${err.ctx.update.update_id}:`, err.error));

if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  Deno.serve(webhookCallback(bot, "std/http"));
} else {
  console.log("Bot starting...");
  bot.start();
}
