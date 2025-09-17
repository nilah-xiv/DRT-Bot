# 🏆 DRT Bot – Death Roll Tournament Bot

A Discord bot for running Death Roll tournaments with signups, nicknames, withdrawals, and automatic bracket creation (via Challonge API).  

---

## 📦 Requirements

- [Node.js](https://nodejs.org/) v18+  
- [npm](https://www.npmjs.com/) (comes with Node.js)  
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)  
- A Challonge API key from [Challonge](https://challonge.com/settings/developer)  

---

## 🚀 Setup

1. **Unzip this project** into a folder:  
   ```bash
   unzip drt-bot.zip -d drt-bot
   cd drt-bot
   ```

2. **Install dependencies**:  
   ```bash
   npm install
   ```

3. **Create a `.env` file** in the project root with your configuration:  

   ```ini
   DISCORD_TOKEN=your_discord_bot_token_here
   CHANNEL_ID=123456789012345678
   OWNER_ROLE_ID=123456789012345678
   STAFF_ROLE_ID=123456789012345678
   CHALLONGE_API_KEY=your_challonge_api_key_here
   ```

   ⚠️ Never commit or share this `.env` file — it contains secrets.

4. **Run the bot**:  
   ```bash
   node index.js
   ```

   Or keep it running in the background with [pm2](https://pm2.keymetrics.io/):  
   ```bash
   pm2 start index.js --name drt-bot
   ```

---

## 🛠️ Features

- **Tournament Signup Message**:  
  Players can sign up, withdraw, or set nicknames with buttons.  

- **Friends Signups**:  
  Owners can add multiple friends at once.  

- **Admin Controls**:  
  - Create a new tournament  
  - Start a bracket  
  - List players  
  - Manage signups  
