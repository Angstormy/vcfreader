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

// --- 3. Public Command Handlers (with Differentiated /start) ---

bot.command("start", (ctx) => {
    const userId = ctx.from?.id;

    if (userId?.toString() === ADMIN_ID) {
        // --- Admin Welcome Message ---
        const welcomeText = `👑 **Admin Panel**

Welcome, Administrator! You have access to all user and admin commands.

**Admin Commands:**
/adduser <ID> - Manually add a user to the whitelist.
/removeuser <ID> - Remove a user from the whitelist.
/listusers - See all whitelisted users.

**User Features:**
- Send a single VCF file to process it instantly.
- Use /processbatch to send multiple files at once.`;
        ctx.reply(welcomeText, { parse_mode: "Markdown" });
    } else {
        // --- Regular User Welcome Message ---
        const welcomeText = `👋 **Welcome!**

I can process VCF contact files.

**How to Use:**
1.  Use the /requestaccess command to ask for permission.
2.  Once approved, just send me a \`.vcf\` file to process it.

If you have multiple files, you can use the /processbatch command (once approved).`;
        ctx.reply(welcomeText, { parse_mode: "Markdown" });
    }
});


bot.command("myid", (ctx) => {
  const userId = ctx.from?.id;
  ctx.reply(`Your Telegram User ID is: \`${userId}\``, { parse_mode: "MarkdownV2" });
});

// --- 4. Access Request & Admin Systems ---

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

// --- Manual Admin Commands ---
const admin = bot.filter((ctx) => ctx.from?.id.toString() === ADMIN_ID);

admin.command("adduser", async (ctx) => {
  const userIdToAdd = parseInt(ctx.match, 10);
  if (isNaN(userIdToAdd)) return ctx.reply("Usage: /adduser <ID>");
  await kv.set(["whitelist", userIdToAdd], true);
  await ctx.reply(`✅ User \`${userIdToAdd}\` has been added.`, { parse_mode: "MarkdownV2" });
});

admin.command("removeuser", async (ctx) => {
  const userIdToRemove = parseInt(ctx.match, 10);
  if (isNaN(userIdToRemove)) return ctx.reply("Usage: /removeuser <ID>");
  await kv.delete(["whitelist", userIdToRemove]);
  await ctx.reply(`🗑️ User \`${userIdToRemove}\` has been removed.`, { parse_mode: "MarkdownV2" });
});

admin.command("listusers", async (ctx) => {
  const entries = kv.list({ prefix: ["whitelist"] });
  const userIds: number[] = [];
  for await (const entry of entries) {
    userIds.push(entry.key[1] as number);
  }
  if (userIds.length === 0) return ctx.reply("The whitelist is empty.");
  const userList = userIds.map(id => `• \`${id}\``).join("\n");
  await ctx.reply(`📜 **Whitelisted Users:**\n\n${userList}`, { parse_mode: "MarkdownV2" });
});

// --- 5. VCF File Processing Logic ---
bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.file_name?.toLowerCase().endsWith(".vcf")) return ctx.reply("Please send a valid `.vcf` file.");
    await ctx.reply("⏳ Processing your VCF file...");
    try {
        const file = await ctx.getFile();
        const filePath = file.file_path;
        if (!filePath) throw new Error("File path is not available.");
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
        const fileContent = await response.text();

        const contacts: { name: string, tel: string }[] = [];
        const vcardBlocks = fileContent.split("BEGIN:VCARD");
        for (const block of vcardBlocks) {
            if (block.trim() === "") continue;
            let contactName: string | null = null;
            let contactTel: string | null = null;
            const lines = block.split(/\r?\n/);
            for (const line of lines) {
                if (line.toUpperCase().startsWith("FN:")) contactName = line.substring(line.indexOf(":") + 1).trim();
                else if (!contactName && line.toUpperCase().startsWith("N:")) contactName = line.substring(line.indexOf(":") + 1).replace(/;/g, ' ').trim();
                if (line.toUpperCase().startsWith("TEL")) {
                    const potentialTel = line.substring(line.lastIndexOf(":") + 1).trim();
                    if (potentialTel) contactTel = potentialTel;
                }
            }
            if (contactName && contactTel) contacts.push({ name: contactName, tel: contactTel });
        }

        if (contacts.length === 0) return ctx.reply("Could not find any valid contacts. Please ensure each contact has both a name (FN: or N:) and a phone number (TEL:).");
        
        const rawFileName = doc.file_name || "Untitled.vcf";
        const sanitizedFileName = rawFileName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let table = `<b>File:</b> <code>${sanitizedFileName}</code>\n\n`;
        table += '<b>Processed Contacts</b>\n<pre>';
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
