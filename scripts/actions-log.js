require('../src/config');
const database = require('../src/services/database');
async function main() {
    const flags = {'--limit':'limit','--user':'target','--actor':'actor','--source':'source','--status':'status'};
    const args = process.argv.slice(2);
    const options = {};
    for (let i=0; i<args.length; i+=2) {
        if (!Object.hasOwn(flags,args[i]) || !args[i+1]) throw new Error('Использование: npm run actions:log -- --limit 20 --user логин --actor модератор --source chat --status confirmed');
        options[flags[args[i]]] = args[i+1];
    }
    await database.ready;
    const rows = await database.getModerationActions(options);
    console.log(JSON.stringify(rows.map(row => ({...row,
        created_at:new Date(row.created_at).toISOString(),
        finished_at:row.finished_at ? new Date(row.finished_at).toISOString() : null
    })),null,2));
}
main().catch(error => {console.error(error.message);process.exitCode=1;}).finally(() => database.close());
