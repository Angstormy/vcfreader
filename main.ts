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

type UserDetails = {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
};

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


// --- 3. Public Command Handlers & Admin Welcome ---

bot.command("start", (ctx) => {
  if (ctx.from?.id.toString() === ADMIN_ID) {
      const welcomeText = `👑 **Admin Panel**\n\nWelcome, Administrator!\n\n**User Management:**\n/requests - View pending requests.\n/manageusers - View and remove whitelisted users.\n/clearwhitelist - **DANGEROUS** Resets the entire user list.`;
      ctx.reply(welcomeText, { parse_mode: "Markdown" });
  } else {
      const welcomeText = `👋 **Welcome!**\n\nI can process VCF contact files.\n\nTo get started, please use the /requestaccess command to submit your request for approval.`;
      ctx.reply(welcomeText, { parse_mode: "Markdown" });
  }
});

bot.command("myid", (ctx) => {
  const userId = ctx.from?.id;
  ctx.reply(`Your Telegram User ID is: \`${userId}\``, { parse_mode: "MarkdownV2" });
});


// --- 4. Access Request & User Management Systems ---

// Helper function to build the list of pending requests
async function buildRequestsMessage() {
    const entries = kv.list<UserDetails>({ prefix: ["pending"] });
    const pendingUsers: UserDetails[] = [];
    for await (const entry of entries) {
        if (typeof entry.value === 'object' && entry.value !== null) {
            pendingUsers.push(entry.value);
        }
    }
    if (pendingUsers.length === 0) return { text: "✅ No pending access requests.", keyboard: new InlineKeyboard() };
    
    let text = `<b>Pending Access Requests (${pendingUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    pendingUsers.forEach((user, index) => {
        text += `<b>${index + 1}. ${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n   ID: <code>${user.id}</code>\n`;
        keyboard.text(`✅ Approve ${user.firstName}`, `approve_${user.id}`).text(`❌ Reject ${user.firstName}`, `reject_${user.id}`).row();
    });
    return { text, keyboard };
}

// Helper function to build the list of whitelisted users for removal
async function buildWhitelistMessage() {
    const entries = kv.list<UserDetails>({ prefix: ["whitelist"] });
    const whitelistedUsers: UserDetails[] = [];
    // THIS CHECK PREVENTS THE 'UNDEFINED' BUG
    for await (const entry of entries) {
        if (typeof entry.value === 'object' && entry.value !== null) {
            whitelistedUsers.push(entry.value);
        }
    }
    if (whitelistedUsers.length === 0) return { text: "✅ The user whitelist is currently empty.", keyboard: new InlineKeyboard() };

    let text = `<b>Manage Whitelisted Users (${whitelistedUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    whitelistedUsers.forEach((user, index) => {
        text += `<b>${index + 1}. ${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n   ID: <code>${user.id}</code>\n`;
        keyboard.text(`🗑️ Remove ${user.firstName}`, `remove_${user.id}`).row();
    });
    return { text, keyboard };
}

// User-facing command
bot.command("requestaccess", async (ctx) => {
  const user = ctx.from;
  if (!user) return;
  if (user.id.toString() === ADMIN_ID || (await kv.get(["whitelist", user.id])).value) return ctx.reply("✅ You are already authorized.");
  if ((await kv.get(["pending", user.id])).value) return ctx.reply("⏳ Your request is already pending.");

  const userDetails: UserDetails = { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username };
  await kv.set(["pending", user.id], userDetails);
  await ctx.reply("✅ Your request has been submitted for review.");
  await bot.api.sendMessage(ADMIN_ID, `New access request received. Use /requests to view.`).catch(console.error);
});

// Admin commands
const admin = bot.filter((ctx) => ctx.from?.id.toString() === ADMIN_ID);

admin.command("requests", async (ctx) => {
    const { text, keyboard } = await buildRequestsMessage();
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

admin.command("manageusers", async (ctx) => {
    const { text, keyboard } = await buildWhitelistMessage();
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

// NEW COMMAND TO FIX THE DATABASE
admin.command("clearwhitelist", async (ctx) => {
    const entries = kv.list<UserDetails>({ prefix: ["whitelist"] });
    let count = 0;
    for await (const entry of entries) {
        await kv.delete(entry.key);
        count++;
    }
    await ctx.reply(`✅ Whitelist cleared. ${count} users have been removed. Please ask them to request access again.`);
});

// Callback handler for buttons
bot.callbackQuery(/^(approve|reject|remove)_(\d+)$/, async (ctx) => {
  const action = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  
  if (action === 'approve' || action === 'reject') {
      const pendingUser = await kv.get<UserDetails>(["pending", userId]);
      await kv.delete(["pending", userId]);

      if (action === "approve" && pendingUser.value) {
          await kv.set(["whitelist", userId], pendingUser.value);
          await bot.api.sendMessage(userId, "🎉 Your access request has been approved!").catch(console.error);
          await ctx.answerCallbackQuery({ text: `${pendingUser.value.firstName} approved.` });
      } else {
          await bot.api.sendMessage(userId, "😔 Your access request has been denied.").catch(console.error);
          await ctx.answerCallbackQuery({ text: `${pendingUser.value?.firstName || 'User'} rejected.` });
      }
      const { text, keyboard } = await buildRequestsMessage();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });

  } else if (action === 'remove') {
      const removedUser = await kv.get<UserDetails>(["whitelist", userId]);
      await kv.delete(["whitelist", userId]);
      await ctx.answerCallbackQuery({ text: `${removedUser.value?.firstName || 'User'} has been removed.` });
      const { text, keyboard } = await buildWhitelistMessage();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
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
            if (contactName && contactTel) contacts.push({ name: contactName, tel: contactTel });
        }
        if (contacts.length === 0) return ctx.reply("Could not find any valid contacts.");
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
        await ctx.reply("An error occurred while processing the file.");
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
