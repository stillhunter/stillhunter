// The sample data a trial puts into the garden-log app on a lane once the app
// has started, the same for every arm of a feature. The stillhunter arm's
// reset runs it again after the app's own reset (which leaves only the demo
// user), so every probe and every proof re-run starts from the data the hunt
// started from. It imports nothing, so a trial runs a copy of it from its own
// folder, and nothing the arm can read names a path in this repository.
//   node seed.mjs <lane> <feature>

export const FEATURES = ['harvest-stats', 'plant-journal', 'watering-log'];
export const DEMO = { DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'demo-password' };
export const lanePorts = (lane) => ({ web: 3790 + lane, api: 8790 + lane });

export async function seed(lane, feature, base = `http://127.0.0.1:${lanePorts(lane).api}/api`) {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO.DEMO_EMAIL, password: DEMO.DEMO_PASSWORD }),
  });
  if (!login.ok) throw new Error(`seed login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`seed POST ${p} failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const north = await post('/beds', { name: 'North bed', sunlight: 'full_sun', notes: '' });
  const shade = await post('/beds', { name: 'Shade corner', sunlight: 'shade', notes: '' });
  const tomato = await post('/plants', { name: 'Tomato', variety: 'Sungold', bed_id: north.id, planted_on: '2026-04-10' });
  const courgette = await post('/plants', { name: 'Courgette', variety: '', bed_id: north.id, planted_on: '2026-05-02' });
  const lettuce = await post('/plants', { name: 'Lettuce', variety: 'Little Gem', bed_id: shade.id, planted_on: '2026-03-20' });
  for (const [plant, grams, on] of [
    [tomato, 300, '2025-08-10'], [tomato, 450, '2026-07-15'], [tomato, 600, '2026-08-03'],
    [courgette, 1200, '2026-07-20'], [lettuce, 200, '2026-06-05'], [lettuce, 150, '2026-09-30'],
  ]) await post('/harvests', { plant_id: plant.id, weight_grams: grams, harvested_on: on });
  if (feature === 'plant-journal') {
    await post('/journal', { plant_id: tomato.id, entry_on: '2026-06-01', body: 'First flowers opened; watered deeply.' });
    await post('/journal', { plant_id: tomato.id, entry_on: '2026-07-02', body: 'Tied the stems to canes.' });
    await post('/journal', { plant_id: lettuce.id, entry_on: '2026-05-14', body: 'Thinned the seedlings.' });
  }
  if (feature === 'watering-log') {
    await post('/waterings', { bed_id: north.id, watered_on: '2026-11-01', litres: 10 });
    await post('/waterings', { bed_id: shade.id, watered_on: '2026-11-05', litres: 4 });
  }
}

// Run as a script, from any spelling of its path: a trial's folder can sit
// under a symbolic link ($TMPDIR on macOS), which import.meta.url resolves.
// Built-in modules only, so a copy still needs nothing beside it.
const { realpathSync } = process.getBuiltinModule('node:fs');
const { fileURLToPath } = process.getBuiltinModule('node:url');
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [laneText, feature] = process.argv.slice(2);
  if (!/^\d$/.test(laneText ?? '') || !FEATURES.includes(feature)) {
    console.error(`usage: seed.mjs <lane 0-9> <${FEATURES.join('|')}>`);
    process.exit(64);
  }
  try {
    await seed(Number(laneText), feature);
  } catch (e) {
    console.error(`seed failed: ${e.message}`);
    process.exit(1);
  }
}
