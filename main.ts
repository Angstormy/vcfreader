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

// --- 2. Menu Building Functions ---

// Main Menu
function buildMainMenu(isAdmin: boolean) {
    const text = isAdmin 
        ? `👑 **Admin Panel**\n\nWelcome, Administrator! Please choose an option below.`
        : `👋 **Welcome!**\n\nI can process VCF contact files. To get started, please request access.`;
    
    const keyboard = new InlineKeyboard();

    if (isAdmin) {
        keyboard.text("View Pending Requests", "view_requests").row();
        keyboard.text("Manage Whitelisted Users", "manage_users").row();
    } else {
        keyboard.text("➡️ Request Access", "request_access").row();
    }
    return { text, keyboard };
}

// Menu for Pending Requests
async function buildRequestsMenu() {
    const entries = kv.list<UserDetails>({ prefix: ["pending"] });
    const pendingUsers: UserDetails[] = [];
    for await (const entry of entries) pendingUsers.push(entry.value);

    if (pendingUsers.length === 0) {
        return { text: "✅ No pending access requests.", keyboard: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu") };
    }
    
    let text = `<b>Pending Access Requests (${pendingUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    pendingUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n`;
        keyboard.text(`✅ Approve ${user.firstName}`, `approve_${user.id}`).text(`❌ Reject ${user.firstName}`, `reject_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

// Menu for Managing Whitelisted Users
async function buildWhitelistMenu() {
    const entries = kv.list<UserDetails>({ prefix: ["whitelist"] });
    const whitelistedUsers: UserDetails[] = [];
    for await (const entry of entries) {
        if (typeof entry.value === 'object' && entry.value !== null) {
            whitelistedUsers.push(entry.value);
        }
    }
    if (whitelistedUsers.length === 0) {
        return { text: "✅ The user whitelist is currently empty.", keyboard: new InlineKeyboard().text("⬅️ Back to Main Menu", "main_menu") };
    }

    let text = `<b>Manage Whitelisted Users (${whitelistedUsers.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();
    whitelistedUsers.forEach((user) => {
        text += `• <b>${user.firstName} ${user.lastName || ''}</b> (@${user.username || 'N/A'})\n`;
        keyboard.text(`🗑️ Remove ${user.firstName}`, `remove_${user.id}`).row();
    });
    keyboard.text("⬅️ Back to Main Menu", "main_menu");
    return { text, keyboard };
}

// --- 3. Whitelisting Middleware ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() === ADMIN_ID) return next();
  if (ctx.callbackQuery) return next(); 

  const command = ctx.message?.text?.split(" ")[0];
  if (command === "/start" || command === "/myid") return next();

  const isWhitelisted = (await kv.get(["whitelist", ctx.from!.id])).value;
  if (isWhitelisted) {
    await next();
  } else {
    await ctx.reply("❌ You are not authorized to use this feature. Please request access from the main menu.", {
        reply_markup: new InlineKeyboard().text("➡️ Request Access", "request_access")
    });
  }
});


// --- 4. Command and Callback Handlers ---

bot.command("start", async (ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    const { text, keyboard } = buildMainMenu(isAdmin);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("myid", (ctx) => {
  ctx.reply(`Your Telegram User ID is: \`${ctx.from.id}\``, { parse_mode: "MarkdownV2" });
});

bot.command("clearwhitelist", async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    const entries = kv.list({ prefix: ["whitelist"] });
    let count = 0;
    for await (const entry of entries) {
        await kv.delete(entry.key);
        count++;
    }
    await ctx.reply(`✅ Whitelist cleared. ${count} users removed.`);
});

// The Master Callback Handler for ALL button clicks
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    if (data === "main_menu") {
        const isAdmin = userId.toString() === ADMIN_ID;
        const { text, keyboard } = buildMainMenu(isAdmin);
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }

    if (data === "view_requests" && userId.toString() === ADMIN_ID) {
        const { text, keyboard } = await buildRequestsMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }
    
    if (data === "manage_users" && userId.toString() === ADMIN_ID) {
        const { text, keyboard } = await buildWhitelistMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        await ctx.answerCallbackQuery();
        return;
    }

    if (data === "request_access") {
        const user = ctx.from;
        if (user.id.toString() === ADMIN_ID || (await kv.get(["whitelist", user.id])).value) {
            await ctx.answerCallbackQuery({ text: "✅ You are already authorized.", show_alert: true });
            return;
        }
        if ((await kv.get(["pending", user.id])).value) {
            await ctx.answerCallbackQuery({ text: "⏳ Your request is already pending.", show_alert: true });
            return;
        }
        const userDetails: UserDetails = { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username };
        await kv.set(["pending", user.id], userDetails);
        await ctx.answerCallbackQuery({ text: "✅ Your request has been submitted!", show_alert: true });
        await bot.api.sendMessage(ADMIN_ID, `🔔 New access request from ${user.first_name}. Use /start to view.`).catch(console.error);
        return;
    }

    const [action, targetIdStr] = data.split("_");
    const targetId = parseInt(targetIdStr, 10);

    if (userId.toString() !== ADMIN_ID || !targetId) {
        await ctx.answerCallbackQuery({ text: "❌ Action not allowed." });
        return;
    }

    if (action === "approve") {
        const pendingUser = await kv.get<UserDetails>(["pending", targetId]);
        if (pendingUser.value) {
            await kv.delete(["pending", targetId]);
            await kv.set(["whitelist", targetId], pendingUser.value);
            await bot.api.sendMessage(targetId, "🎉 Your access request has been approved!").catch(console.error);
            await ctx.answerCallbackQuery({ text: `${pendingUser.value.firstName} approved.` });
            const { text, keyboard } = await buildRequestsMenu();
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    } else if (action === "reject") {
        await kv.delete(["pending", targetId]);
        await bot.api.sendMessage(targetId, "😔 Your access request has been denied.").catch(console.error);
        await ctx.answerCallbackQuery({ text: "User rejected." });
        const { text, keyboard } = await buildRequestsMenu();
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } else if (action === "remove") {
        const removedUser = await kv.get<UserDetails>(["whitelist", targetId]);
        await kv.delete(["whitelist", targetId]);

        // --- THIS IS THE NEW LINE ---
        await bot.api.sendMessage(targetId, "Your access to this bot has been revoked by the administrator.").catch(console.error);

        await ctx.answerCallbackQuery({ text: `${removedUser.value?.firstName || 'User'} has been removed.` });
        const { text, keyboard } = await buildWhitelistMenu();
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
