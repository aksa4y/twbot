const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DATABASE_FILE || path.join(__dirname, '../../data/bot_database.db');
require('node:fs').mkdirSync(path.dirname(dbPath), {recursive:true});
const connection = new DatabaseSync(dbPath);
// Compatibility wrapper for existing repository functions; statements execute synchronously,
// callbacks preserve their sqlite3 signatures. No external native module is required.
const db = {
 serialize(fn) { fn(); },
 run(sql, params, callback) {
  if (typeof params === 'function') {callback=params;params=[];}
  try {const result=connection.prepare(sql).run(...(params || []));callback?.call({changes:Number(result.changes),lastID:Number(result.lastInsertRowid)},null);}
  catch(err) {if(callback) callback(err);else throw err;}
 },
 get(sql, params, callback) {
  if(typeof params==='function'){callback=params;params=[];}
  try {callback(null,connection.prepare(sql).get(...(params || [])));}catch(err){callback(err);}
 },
 all(sql, params, callback) {
  if(typeof params==='function'){callback=params;params=[];}
  try {callback(null,connection.prepare(sql).all(...(params || [])));}catch(err){callback(err);}
 },
 close(callback) {try {connection.close();callback();}catch(err){callback(err);}}
};

db.serialize(() => {
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA busy_timeout=5000');
    db.run('PRAGMA foreign_keys=ON');
    db.run(`CREATE TABLE IF NOT EXISTS moderation_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL, finished_at INTEGER,
        source TEXT NOT NULL, actor TEXT NOT NULL, actor_id TEXT,
        channel TEXT NOT NULL, command TEXT, request_id TEXT,
        action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL,
        duration INTEGER, parent_id INTEGER, decision_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        confirmation TEXT NOT NULL DEFAULT 'unknown',
        http_status INTEGER, endpoint TEXT, error_kind TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS moderation_actions_date ON moderation_actions(created_at)');
    db.run(`CREATE TABLE IF NOT EXISTS automoderation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        username TEXT NOT NULL,
        message_id TEXT,
        message TEXT NOT NULL,
        rule TEXT NOT NULL,
        actions TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS automoderation_events_date ON automoderation_events(created_at)');
    db.run(`CREATE TABLE IF NOT EXISTS cooldowns (
        scope TEXT NOT NULL,
        username TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(scope, username)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS cooldowns_expiration ON cooldowns(expires_at)');
    db.run(`CREATE TABLE IF NOT EXISTS user_iq (
        username TEXT PRIMARY KEY,
        iq INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        type TEXT,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS spam_tracking (
        username TEXT PRIMARY KEY,
        last_message TEXT,
        count INTEGER,
        last_time INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stream_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT UNIQUE,
        started_at DATETIME,
        current_game TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stream_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        game_name TEXT,
        started_at DATETIME,
        ended_at DATETIME,
        FOREIGN KEY(session_id) REFERENCES stream_sessions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stream_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT,
        game_name TEXT,
        proposed_by TEXT,
        UNIQUE(stream_id, game_name)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT,
        game_name TEXT,
        username TEXT,
        UNIQUE(stream_id, username)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bot_points (
        username TEXT PRIMARY KEY,
        points INTEGER DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS proverbs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS jokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS fortunes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        reason TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_until DATETIME,
        is_active BOOLEAN DEFAULT 1,
        UNIQUE(username, banned_at)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_bonus (
        username TEXT PRIMARY KEY,
        last_bonus DATE DEFAULT CURRENT_DATE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_fortune (
        username TEXT PRIMARY KEY,
        last_fortune DATE DEFAULT CURRENT_DATE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS duels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenger TEXT,
        opponent TEXT,
        amount INTEGER,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter TEXT,
        offender TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS unban_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ban_id INTEGER,
        message_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(ban_id) REFERENCES bans(id)
    )`);


});

function getUserIQ(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT iq FROM user_iq WHERE username = ?', [username], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.iq : null);
        });
    });
}

function updateUserIQ(username, iq) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO user_iq (username, iq, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(username) DO UPDATE SET iq = excluded.iq, updated_at = CURRENT_TIMESTAMP`,
            [username, iq],
            function (err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function getStreamSession(streamId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM stream_sessions WHERE stream_id = ?', [streamId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function createStreamSession({ stream_id, started_at, current_game }) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO stream_sessions (stream_id, started_at, current_game) VALUES (?, ?, ?)',
            [stream_id, new Date(started_at).toISOString(), current_game],
            function (err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, stream_id, started_at, current_game });
            }
        );
    });
}

function updateStreamSessionGame(sessionId, game) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE stream_sessions SET current_game = ? WHERE id = ?', [game, sessionId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function addCategoryToSession(sessionId, { game_name, started_at }) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO stream_categories (session_id, game_name, started_at) VALUES (?, ?, ?)',
            [sessionId, game_name, new Date(started_at).toISOString()],
            function (err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function getLastCategory(sessionId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM stream_categories WHERE session_id = ? ORDER BY started_at DESC LIMIT 1',
            [sessionId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

function updateCategoryEndTime(sessionId, game_name, ended_at) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE stream_categories SET ended_at = ? WHERE session_id = ? AND game_name = ? AND ended_at IS NULL',
            [new Date(ended_at).toISOString(), sessionId, game_name],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function getStreamCategories(sessionId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT game_name, started_at, ended_at FROM stream_categories WHERE session_id = ? ORDER BY started_at',
            [sessionId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function addGameProposal(streamId, gameName, username) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT OR IGNORE INTO stream_games (stream_id, game_name, proposed_by) VALUES (?, ?, ?)',
            [streamId, gameName, username],
            function (err) {
                if (err) reject(err);
                else resolve(this.changes > 0);
            }
        );
    });
}

function voteForGame(streamId, gameName, username) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT OR IGNORE INTO votes (stream_id, game_name, username) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM stream_games WHERE stream_id=? AND game_name=?)',
            [streamId, gameName, username, streamId, gameName],
            function (err) {
                if (err) reject(err);
                else resolve(this.changes > 0);
            }
        );
    });
}

function getVotingResults(streamId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT sg.game_name, COUNT(v.username) as votes
             FROM stream_games sg
             LEFT JOIN votes v ON sg.stream_id = v.stream_id AND sg.game_name = v.game_name
             WHERE sg.stream_id = ?
             GROUP BY sg.game_name
             ORDER BY votes DESC`,
            [streamId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function resetVoting(streamId) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM votes WHERE stream_id = ?', [streamId], (err) => {
            if (err) reject(err);
            else {
                db.run('DELETE FROM stream_games WHERE stream_id = ?', [streamId], (err2) => {
                    if (err2) reject(err2);
                    else resolve();
                });
            }
        });
    });
}

function getUserPoints(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT points FROM bot_points WHERE username = ?', [username], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.points : 0);
        });
    });
}

function run(sql, params = []) {
 return new Promise((resolve,reject) => db.run(sql, params, function(err) {err ? reject(err) : resolve({changes:this.changes,lastID:this.lastID});}));
}
function get(sql, params = []) {
 return new Promise((resolve,reject) => db.get(sql,params,(err,row) => err ? reject(err) : resolve(row)));
}
const {username: validUser, amount: validAmount} = require('../utils/security');
const MAX_BALANCE = 1000000000;
// Work is synchronous between BEGIN and COMMIT, so no other operation can interleave.
function transaction(work) {
 try {
  connection.exec('BEGIN IMMEDIATE');
  const run=(sql,args=[])=>{const r=connection.prepare(sql).run(...args);return {changes:Number(r.changes),lastID:Number(r.lastInsertRowid)};};
  const get=(sql,args=[])=>connection.prepare(sql).get(...args);
  const result=work(run,get);
  connection.exec('COMMIT');
  return Promise.resolve(result);
 } catch(err) {try{connection.exec('ROLLBACK');}catch{}return Promise.reject(err);}
}
async function addUserPoints(name, amount) {
 name=validUser(name);amount=validAmount(amount);
 const result = await run(`INSERT INTO bot_points(username,points) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET points=points+excluded.points,last_seen=CURRENT_TIMESTAMP WHERE points+excluded.points<=?`,[name,amount,MAX_BALANCE]);
 if (!result.changes) throw new Error('Достигнут предел баланса');
}
async function spendUserPoints(name, amount) {
 name=validUser(name);amount=validAmount(amount);
 const result=await run('UPDATE bot_points SET points=points-?,last_seen=CURRENT_TIMESTAMP WHERE username=? AND points>=?',[amount,name,amount]);
 if(!result.changes) throw new Error('Недостаточно очков');
}
async function transferPoints(from,to,amount) {
 from=validUser(from);to=validUser(to);amount=validAmount(amount);
 if(from===to) throw new Error('Нельзя переводить себе');
 await transaction((run)=>{
  const debit=run('UPDATE bot_points SET points=points-? WHERE username=? AND points>=?',[amount,from,amount]);
  if(!debit.changes) throw new Error('Недостаточно очков');
  const credit=run('INSERT INTO bot_points(username,points) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET points=points+excluded.points WHERE points+excluded.points<=?',[to,amount,MAX_BALANCE]);
  if(!credit.changes) throw new Error('Достигнут предел баланса');
 });
}
async function settleDuel(id, winner) {
 return transaction((run,get)=>{
  const duel=get("SELECT * FROM duels WHERE id=? AND status='pending'",[id]);
  if(!duel || Date.parse(duel.expires_at)<=Date.now()) throw new Error('Дуэль завершена или истекла');
  if(![duel.challenger,duel.opponent].includes(winner)) throw new Error('Некорректный победитель');
  for(const name of [duel.challenger,duel.opponent]) {
   const balance=get('SELECT points FROM bot_points WHERE username=?',[name]);
   if(!balance || balance.points<duel.amount) throw new Error('Недостаточно очков у участника');
  }
  const loser=winner===duel.challenger?duel.opponent:duel.challenger;
  run('UPDATE bot_points SET points=points-? WHERE username=?',[duel.amount,loser]);
  const credit=run('UPDATE bot_points SET points=points+? WHERE username=? AND points+?<=?',[duel.amount,winner,duel.amount,MAX_BALANCE]);
  if(!credit.changes) throw new Error('Достигнут предел баланса');
  run("UPDATE duels SET status='completed' WHERE id=?",[id]);
 });
}
async function recordWarn(name, reason = 'Предупреждение модератора') {
 return transaction((run,get)=>{
  const count=get("SELECT COUNT(*) AS n FROM violations WHERE username=? AND type='warn' AND created_at>datetime('now','-1 day')",[name]);
  run("INSERT INTO violations(username,type,reason) VALUES (?,'warn',?)",[name,reason]);
  return count.n%3+1;
 });
}

function getRandomProverb() {
    return new Promise((resolve, reject) => {
        db.get('SELECT template FROM proverbs ORDER BY RANDOM() LIMIT 1', (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.template : null);
        });
    });
}

function addProverb(template) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO proverbs (template) VALUES (?)', [template], function (err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

async function getStreamStats(streamId) {
 const session=await get('SELECT started_at FROM stream_sessions WHERE stream_id=?',[streamId]);
 if(!session)return null;
 const since=new Date(session.started_at).toISOString().replace('T',' ').slice(0,19);
 const warns=await get('SELECT COUNT(*) AS n FROM violations WHERE created_at>=?',[since]);
 const bans=await get('SELECT COUNT(*) AS n FROM bans WHERE banned_at>=?',[since]);
 return {warns:warns.n,bans:bans.n};
}
function getPendingReports() {return new Promise((resolve,reject)=>db.all("SELECT id,offender,reason FROM reports WHERE status='pending' ORDER BY id DESC LIMIT 10",(err,rows)=>err?reject(err):resolve(rows)));}


function getTopPoints(limit) {
    return new Promise((resolve, reject) => {
        db.all('SELECT username, points FROM bot_points ORDER BY points DESC LIMIT ?', [validAmount(limit,100)], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getTopIQ(limit) {
    return new Promise((resolve, reject) => {
        db.all('SELECT username, iq FROM user_iq ORDER BY iq DESC LIMIT ?', [validAmount(limit,100)], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getTopWarns(limit) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT username, COUNT(*) as warns FROM violations GROUP BY username ORDER BY warns DESC LIMIT ?`,
            [validAmount(limit,100)],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function getTopBans(limit) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT username, COUNT(*) as bans FROM bans WHERE is_active = 1 GROUP BY username ORDER BY bans DESC LIMIT ?`,
            [validAmount(limit,100)],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function getUserWarns(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as warns FROM violations WHERE username = ?', [username], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.warns : 0);
        });
    });
}

function getRandomJoke() {
    return new Promise((resolve, reject) => {
        db.get('SELECT text FROM jokes ORDER BY RANDOM() LIMIT 1', (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.text : null);
        });
    });
}

function addJoke(text) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO jokes (text) VALUES (?)', [text], function (err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

function getRandomFortune() {
    return new Promise((resolve, reject) => {
        db.get('SELECT text FROM fortunes ORDER BY RANDOM() LIMIT 1', (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.text : null);
        });
    });
}

function addFortune(text) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO fortunes (text) VALUES (?)', [text], function (err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

async function dailyClaim(table,column,name) {
 name=validUser(name);
 const result=await run(`INSERT INTO ${table}(username,${column}) VALUES (?,date('now')) ON CONFLICT(username) DO UPDATE SET ${column}=excluded.${column} WHERE ${column}<>excluded.${column}`,[name]);
 return result.changes>0;
}
function checkDailyBonus(name) {return dailyClaim('daily_bonus','last_bonus',name);}
function checkDailyFortune(name) {return dailyClaim('daily_fortune','last_fortune',name);}

function createBan(username, reason, durationDays = null) {
    return new Promise((resolve, reject) => {
        const bannedUntil = durationDays ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000) : null;
        db.run(
            'INSERT INTO bans (username, reason, banned_until, is_active) VALUES (?, ?, ?, 1)',
            [username, reason, bannedUntil ? bannedUntil.toISOString() : null],
            function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function unbanUser(username) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE bans SET is_active = 0 WHERE username = ? AND is_active = 1', [username], function (err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

function getExpiredBans() {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.all(
            'SELECT * FROM bans WHERE is_active = 1 AND banned_until IS NOT NULL AND banned_until <= ?',
            [now],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function createUnbanRequest(banId, messageId) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO unban_requests (ban_id, message_id) VALUES (?, ?)',
            [banId, messageId],
            function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function resolveUnbanRequest(messageId, status) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE unban_requests SET status = ? WHERE message_id = ?',
            [status, messageId],
            function (err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function createReport(reporter, offender, reason) {
    reporter=validUser(reporter);offender=validUser(offender);
    if(typeof reason!=='string' || !reason.trim() || reason.length>500) throw new Error('Некорректная причина');
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO reports (reporter, offender, reason) VALUES (?, ?, ?)',
            [reporter, offender, reason],
            function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function createDuel(challenger, opponent, amount, expiresAt) {
 challenger=validUser(challenger);opponent=validUser(opponent);amount=validAmount(amount);
 if(challenger===opponent || !Number.isFinite(expiresAt.getTime())) throw new Error('Некорректная дуэль');
 return transaction((run,get)=>{
  run("UPDATE duels SET status='expired' WHERE status='pending' AND julianday(expires_at)<=julianday('now')");
  const existing=get("SELECT id FROM duels WHERE status='pending' AND (challenger IN (?,?) OR opponent IN (?,?))",[challenger,opponent,challenger,opponent]);
  if(existing) throw new Error('У участника уже есть активная дуэль');
  return run('INSERT INTO duels(challenger,opponent,amount,expires_at) VALUES (?,?,?,?)',[challenger,opponent,amount,expiresAt.toISOString()]).lastID;
 });
}

function getPendingDuelByOpponent(opponent) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM duels WHERE opponent = ? AND status = 'pending' AND julianday(expires_at) > julianday('now')`,
            [opponent],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

function updateDuelStatus(duelId, status) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE duels SET status = ? WHERE id = ?', [status, duelId], function (err) {
            if (err) reject(err);
            else resolve();
        });
    });
}


let nextCooldownCleanup = 0;
function validateCooldown(scope, name, duration, now) {
 if (typeof scope !== 'string' || !/^[a-z0-9:_#-]{1,128}$/.test(scope)) throw new Error('Некорректная область кулдауна');
 name = validUser(name);
 if (!Number.isSafeInteger(duration) || duration < 1 || duration > 7*24*60*60*1000 ||
     !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now+duration)) throw new Error('Некорректное время кулдауна');
 return name;
}
function claimCooldownStatement(scope, name, duration, now) {
 return connection.prepare(`INSERT INTO cooldowns(scope,username,expires_at) VALUES (?,?,?)
 ON CONFLICT(scope,username) DO UPDATE SET expires_at=excluded.expires_at
 WHERE cooldowns.expires_at<=?`).run(scope,name,now+duration,now).changes > 0;
}
function claimCooldown(scope, name, duration, now = Date.now()) {
 name = validateCooldown(scope,name,duration,now);
 if (now >= nextCooldownCleanup) {
  connection.prepare('DELETE FROM cooldowns WHERE expires_at<=?').run(now);
  nextCooldownCleanup = now+300000;
 }
 return claimCooldownStatement(scope,name,duration,now);
}
function clearCooldownScope(scope) {
 // Validate before deleting; the placeholder nickname is not stored.
 validateCooldown(scope,'validation',1,0);
 connection.prepare('DELETE FROM cooldowns WHERE scope=?').run(scope);
}
async function awardActivityPoints(name, scope, now = Date.now()) {
 name = validateCooldown(scope,name,300000,now);
 return transaction((run) => {
  if (!claimCooldownStatement(scope,name,300000,now)) return false;
  const result = run(`INSERT INTO bot_points(username,points) VALUES (?,1)
   ON CONFLICT(username) DO UPDATE SET points=points+1,last_seen=CURRENT_TIMESTAMP WHERE points<?`,[name,MAX_BALANCE]);
  if (!result.changes) throw new Error('Достигнут предел баланса');
  return true;
 });
}


function recordAutoModerationEvent(event) {
 const channel = validUser(event.channel);
 const username = validUser(event.username);
 if (!['observe','active'].includes(event.mode) || !['link','forbidden_word','caps','spam'].includes(event.rule)) throw new Error('Некорректное событие автомодерации');
 const now = Date.now();
 const status = event.mode === 'observe' ? 'observed' : 'pending';
 return transaction((run) => {
  run('DELETE FROM automoderation_events WHERE created_at<?',[now-30*24*60*60*1000]);
  const result = run(`INSERT INTO automoderation_events(created_at,channel,username,message_id,message,rule,actions,mode,status)
   VALUES (?,?,?,?,?,?,?,?,?)`,[now,channel,username,String(event.messageId || '').slice(0,100),String(event.message).slice(0,2000),event.rule,JSON.stringify(event.actions),event.mode,status]);
  run('DELETE FROM automoderation_events WHERE id NOT IN (SELECT id FROM automoderation_events ORDER BY id DESC LIMIT 10000)');
  return result.lastID;
 });
}
async function finishAutoModerationEvent(id, status) {
 if (!['applied','failed'].includes(status)) throw new Error('Некорректный статус');
 await run("UPDATE automoderation_events SET status=? WHERE id=? AND mode='active' AND status='pending'",[status,id]);
}
function getAutoModerationEvents({limit = 20, username, mode} = {}) {
 limit = validAmount(limit,100);
 const filters=[];const params=[];
 if (username) {filters.push('username=?');params.push(validUser(username));}
 if (mode) {
  if (!['observe','active'].includes(mode)) throw new Error('Некорректный режим');
  filters.push('mode=?');params.push(mode);
 }
 params.push(limit);
 const sql = `SELECT * FROM automoderation_events ${filters.length ? 'WHERE '+filters.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
 return new Promise((resolve,reject) => db.all(sql,params,(err,rows)=>err ? reject(err) : resolve(rows.map(row=>({...row,actions:JSON.parse(row.actions)})))));
}


function auditName(value) {
 try {return validUser(value);} catch {return String(value || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,100);}
}
function recordModerationAction(event) {
 const sources = ['chat','api','automod','system'];
 if (!sources.includes(event.source) || !['ban','unban','timeout','warn','delete','warning'].includes(event.action)) throw new Error('Некорректное действие журнала');
 const text = (value, max) => String(value || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
 const number = value => Number.isSafeInteger(value) && value>0 ? value : null;
 const now = Date.now();
 return transaction((run) => {
  run('DELETE FROM moderation_actions WHERE created_at<?',[now-30*24*60*60*1000]);
  const result = run(`INSERT INTO moderation_actions(created_at,source,actor,actor_id,channel,command,request_id,action,target,reason,duration,parent_id,decision_id)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[now,event.source,auditName(event.actor),text(event.actorId,100),validUser(event.channel),text(event.command,100),text(event.requestId,100),event.action,auditName(event.target),text(event.reason,500),number(event.duration),number(event.parentId),number(event.decisionId)]);
  run('DELETE FROM moderation_actions WHERE id NOT IN (SELECT id FROM moderation_actions ORDER BY id DESC LIMIT 10000)');
  return result.lastID;
 });
}
async function finishModerationAction(id, {status, confirmation, httpStatus, endpoint, errorKind}) {
 if (!['confirmed','rejected','unknown','local','failed','local_error'].includes(status) || !['confirmed','rejected','unknown','not_sent','not_applicable'].includes(confirmation)) throw new Error('Некорректный результат журнала');
 await run(`UPDATE moderation_actions SET finished_at=?,status=?,confirmation=?,http_status=?,endpoint=?,error_kind=? WHERE id=?`,[
  Date.now(),status,confirmation,Number.isInteger(httpStatus)?httpStatus:null,String(endpoint || '').slice(0,100),String(errorKind || '').slice(0,50),id
 ]);
}
function getModerationActions({limit = 20, target, actor, source, status} = {}) {
 limit = validAmount(limit,100);
 const filters=[];const params=[];
 for(const [column,value] of Object.entries({target,actor,source,status})) {
  if (value !== undefined) {filters.push(`${column}=?`);params.push(['actor','target'].includes(column) ? auditName(value) : String(value).slice(0,100));}
 }
 params.push(limit);
 const sql=`SELECT * FROM moderation_actions ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY id DESC LIMIT ?`;
 return new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows)));
}

const ready = new Promise((resolve,reject) => db.get('SELECT 1 FROM unban_requests LIMIT 1', err => err ? reject(err) : resolve()));
async function close() {await new Promise((resolve,reject)=>db.close(err=>err?reject(err):resolve()));}
module.exports = {
    recordModerationAction, finishModerationAction, getModerationActions,
    recordAutoModerationEvent, finishAutoModerationEvent, getAutoModerationEvents,
    ready, close, transferPoints, settleDuel, recordWarn, getPendingReports, claimCooldown, clearCooldownScope, awardActivityPoints,
    getUserIQ,
    updateUserIQ,
    getStreamSession,
    createStreamSession,
    updateStreamSessionGame,
    addCategoryToSession,
    getLastCategory,
    updateCategoryEndTime,
    getStreamCategories,
    addGameProposal,
    voteForGame,
    getVotingResults,
    resetVoting,
    getUserPoints,
    addUserPoints,
    spendUserPoints,
    getRandomProverb,
    addProverb,
    getStreamStats,
    getTopPoints,
    getTopIQ,
    getTopWarns,
    getTopBans,
    getUserWarns,
    getRandomJoke,
    addJoke,
    getRandomFortune,
    addFortune,
    checkDailyBonus,
    checkDailyFortune,
    createBan,
    unbanUser,
    getExpiredBans,
    createUnbanRequest,
    resolveUnbanRequest,
    createReport,
    createDuel,
    getPendingDuelByOpponent,
    updateDuelStatus,
};
