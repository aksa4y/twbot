require('../src/config');
const database = require('../src/services/database');
async function main() {
    const options = {};
    const flags = {'--limit':'limit', '--user':'username', '--mode':'mode'};
    const args = process.argv.slice(2);
    for (let i=0; i<args.length; i+=2) {
        if (!Object.hasOwn(flags,args[i]) || !args[i+1]) throw new Error('Использование: npm run moderation:log -- --limit 20 --user логин --mode observe');
        options[flags[args[i]]] = args[i+1];
    }
    await database.ready;
    const events = await database.getAutoModerationEvents(options);
    // JSON escapes control characters from chat messages instead of printing terminal sequences.
    console.log(JSON.stringify(events.map(event => ({...event, created_at:new Date(event.created_at).toISOString()})),null,2));
}
main().catch(error => {console.error(error.message);process.exitCode=1;}).finally(() => database.close());
