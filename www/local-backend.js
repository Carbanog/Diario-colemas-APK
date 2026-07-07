/*
 * Colmenar Zeta - motor de datos local para Android
 * -------------------------------------------------
 * En la versión de servidor/escritorio, la pantalla (index.html) le pide los datos
 * a un programa Flask a través de "fetch('/api/...')". En el móvil no hay servidor,
 * así que este archivo hace exactamente el mismo trabajo pero guardando todo en una
 * base de datos SQLite dentro del propio teléfono (usando sql.js, que es SQLite
 * "traducido" para poder correr en el navegador).
 *
 * localApi(path, opts) se comporta igual que el fetch() de antes: se le pasa una ruta
 * como '/hives' y unas opciones {method, body}, y devuelve una promesa con el mismo
 * tipo de resultado en JSON que antes daba el servidor. Así, el resto de index.html
 * no ha tenido que cambiar casi nada.
 */

let _db = null;
let _SQL = null;
const DB_FILENAME = 'colmenar.db';
function getFilesystem(){
  const c = window.Capacitor;
  return (c && c.Plugins && c.Plugins.Filesystem) || null;
}
function getShare(){
  const c = window.Capacitor;
  return (c && c.Plugins && c.Plugins.Share) || null;
}
const DIR_DATA = 'DATA';
const DIR_CACHE = 'CACHE';

// ---------- Utilidades ----------
function uid(prefix){ return prefix + '_' + Math.random().toString(16).slice(2, 12) + Date.now().toString(16).slice(-6); }
function nowIso(){ return new Date().toISOString(); }

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // devuelve "data:image/jpeg;base64,xxxx"
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- Arranque / persistencia ----------
async function _loadDbFile(){
  const Filesystem = getFilesystem();
  if(!Filesystem) return null; // en el navegador de pruebas, sin Capacitor, empieza vacío
  try{
    const res = await Filesystem.readFile({ path: DB_FILENAME, directory: DIR_DATA });
    const binary = atob(res.data);
    const bytes = new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }catch(e){
    return null; // no existe todavía: primera vez que se abre la app
  }
}

async function _saveDbFile(){
  const Filesystem = getFilesystem();
  if(!Filesystem){ console.warn('Filesystem no disponible: no se pudo guardar en disco'); return; }
  const bytes = _db.export();
  let binary = '';
  for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  await Filesystem.writeFile({ path: DB_FILENAME, directory: DIR_DATA, data: base64 });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hives (
  id TEXT PRIMARY KEY, nombre TEXT, apiario TEXT, ubicacion TEXT,
  alzas INTEGER DEFAULT 0, excluidor TEXT DEFAULT 'No', created_at TEXT
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, hive_id TEXT, fecha TEXT, clima TEXT, peina TEXT, postura TEXT,
  cria TEXT, poblacion TEXT, reservas TEXT, polen TEXT, plagas TEXT, estado TEXT,
  alimentacion TEXT, tratamiento TEXT, observaciones TEXT,
  cuadros_miel TEXT, cuadros_cria TEXT, cuadros_operculada TEXT, celdas_reales TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY, hive_id TEXT, fecha TEXT, cuadros TEXT, kg TEXT, humedad TEXT, notas TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY, fecha TEXT, origen_hive_id TEXT, origen_desconocido INTEGER DEFAULT 0,
  capturado TEXT, destino_hive_id TEXT, notas TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, fecha TEXT, texto TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS queen_changes (
  id TEXT PRIMARY KEY, hive_id TEXT, fecha TEXT, anio_reina INTEGER, motivo TEXT, notas TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, entry_type TEXT, entry_id TEXT, content TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY, lat REAL, lon REAL, nombre TEXT DEFAULT 'Colmenar Zeta', updated_at TEXT
);
CREATE TABLE IF NOT EXISTS weather_days (
  date TEXT PRIMARY KEY, temp_max REAL, temp_min REAL, precipitation_mm REAL,
  sun_hours REAL, daylight_hours REAL, wind_kmh REAL, weathercode INTEGER, fetched_at TEXT
);
`;

async function initLocalDb(){
  _SQL = await initSqlJs({ locateFile: () => 'sql-wasm.wasm' });
  const existing = await _loadDbFile();
  _db = existing ? new _SQL.Database(existing) : new _SQL.Database();
  _db.run(SCHEMA);
  await _saveDbFile();
}

// ---------- Helpers de consulta ----------
function all(sql, params=[]){
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while(stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function run(sql, params=[]){
  _db.run(sql, params);
}
function one(sql, params=[]){
  const rows = all(sql, params);
  return rows[0] || null;
}

// ---------- Fotos ----------
async function localUploadPhoto(entryType, entryId, blob){
  await _readyPromise;
  const dataUrl = await blobToBase64(blob);
  const pid = uid('p');
  run(`INSERT INTO photos (id, entry_type, entry_id, content, created_at) VALUES (?,?,?,?,?)`,
    [pid, entryType, entryId, dataUrl, nowIso()]);
  await _saveDbFile();
  return pid;
}

function buildPhotosMap(){
  const rows = all(`SELECT * FROM photos`);
  const map = {};
  rows.forEach(p=>{
    const key = `${p.entry_type}:${p.entry_id}`;
    (map[key] = map[key] || []).push({ id: p.id, filename: p.id, dataUrl: p.content });
  });
  return map;
}

// ---------- Clima (llama a Open-Meteo directamente desde el móvil) ----------
async function getWeatherSeason(year){
  const settings = one(`SELECT * FROM settings WHERE id=1`);
  if(!settings || settings.lat == null) return { error: 'sin_ubicacion' };

  const startDate = new Date(Date.UTC(parseInt(year), 0, 1));
  const today = new Date();
  const endDate = (parseInt(year) === today.getFullYear()) ? today : new Date(Date.UTC(parseInt(year), 11, 31));
  if(endDate < startDate) return { days: [] };
  const start = startDate.toISOString().slice(0,10);
  const end = endDate.toISOString().slice(0,10);

  const expectedDays = Math.round((endDate - startDate) / 86400000) + 1;
  const cached = all(`SELECT date FROM weather_days WHERE date BETWEEN ? AND ? AND daylight_hours IS NOT NULL`, [start, end]);

  if(cached.length < expectedDays){
    try{
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${settings.lat}&longitude=${settings.lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration,daylight_duration,windspeed_10m_max,weathercode&timezone=auto`;
      const resp = await fetch(url);
      const data = await resp.json();
      const daily = data.daily || {};
      const dates = daily.time || [];
      dates.forEach((d, i) => {
        const sunH = ((daily.sunshine_duration || [])[i] || 0) / 3600;
        const dayH = ((daily.daylight_duration || [])[i] || 0) / 3600;
        run(`INSERT INTO weather_days (date, temp_max, temp_min, precipitation_mm, sun_hours, daylight_hours, wind_kmh, weathercode, fetched_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(date) DO UPDATE SET temp_max=excluded.temp_max, temp_min=excluded.temp_min,
             precipitation_mm=excluded.precipitation_mm, sun_hours=excluded.sun_hours,
             daylight_hours=excluded.daylight_hours, wind_kmh=excluded.wind_kmh,
             weathercode=excluded.weathercode, fetched_at=excluded.fetched_at`,
          [d, daily.temperature_2m_max[i], daily.temperature_2m_min[i], daily.precipitation_sum[i],
           Math.round(sunH*10)/10, Math.round(dayH*10)/10, daily.windspeed_10m_max[i], daily.weathercode[i], nowIso()]);
      });
      await _saveDbFile();
    }catch(e){
      return { error: 'fetch_failed' };
    }
  }
  const days = all(`SELECT * FROM weather_days WHERE date BETWEEN ? AND ? ORDER BY date`, [start, end]);
  return { days };
}

// ---------- Backup ----------
async function localBackupAndShare(){
  await _readyPromise;
  const payload = {
    formatVersion: 1,
    exportedAt: nowIso(),
    settings: null,
    hives: all(`SELECT * FROM hives`),
    revisions: all(`SELECT * FROM revisions`),
    extractions: all(`SELECT * FROM extractions`),
    swarms: all(`SELECT * FROM swarms`),
    notes: all(`SELECT * FROM notes`),
    queens: all(`SELECT * FROM queen_changes`),
    photos: [],
  };
  const settingsRow = one(`SELECT * FROM settings WHERE id=1`);
  if(settingsRow) payload.settings = { nombre: settingsRow.nombre, lat: settingsRow.lat, lon: settingsRow.lon };

  const zip = new JSZip();
  const photosFolder = zip.folder('photos');
  all(`SELECT * FROM photos`).forEach(p=>{
    const fileName = `${p.id}.jpg`;
    const base64Data = (p.content || '').split(',')[1] || '';
    photosFolder.file(fileName, base64Data, { base64: true });
    payload.photos.push({ id: p.id, entryType: p.entry_type, entryId: p.entry_id, file: fileName });
  });
  zip.file('data.json', JSON.stringify(payload));

  const zipBase64 = await zip.generateAsync({ type: 'base64' });
  const ts = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  await saveAndShareBase64(zipBase64, `colmenar_backup_${ts}.zip`, 'application/zip');
}

async function saveAndShareBase64(base64, filename, mimeType){
  const Filesystem = getFilesystem();
  const Share = getShare();
  if(Filesystem && Share){
    await Filesystem.writeFile({ path: filename, directory: DIR_CACHE, data: base64 });
    const uriResult = await Filesystem.getUri({ path: filename, directory: DIR_CACHE });
    await Share.share({ title: filename, url: uriResult.uri });
  } else {
    // Fallback para cuando se prueba en un navegador normal (sin Capacitor): descarga directa
    const link = document.createElement('a');
    link.href = `data:${mimeType};base64,${base64}`;
    link.download = filename;
    link.click();
  }
}

// ---------- Router: mismo "idioma" que usaba el servidor Flask ----------
async function localApi(path, opts){
  await _readyPromise;
  const method = (opts && opts.method) || 'GET';
  const body = (opts && opts.body) ? JSON.parse(opts.body) : {};
  const seg = path.split('/').filter(Boolean); // ej. ['hives', 'h_123']

  try{
    // ---- Datos completos ----
    if(seg[0] === 'data' && method === 'GET'){
      return {
        hives: all(`SELECT * FROM hives ORDER BY created_at`),
        revisions: all(`SELECT *, hive_id as hiveId FROM revisions ORDER BY fecha DESC, created_at DESC`),
        extractions: all(`SELECT *, hive_id as hiveId FROM extractions ORDER BY fecha DESC, created_at DESC`),
        swarms: all(`SELECT *, origen_hive_id as origenHiveId, destino_hive_id as destinoHiveId FROM swarms ORDER BY fecha DESC, created_at DESC`),
        notes: all(`SELECT * FROM notes ORDER BY fecha DESC, created_at DESC`),
        queens: all(`SELECT *, hive_id as hiveId FROM queen_changes ORDER BY fecha DESC, created_at DESC`),
        photos: buildPhotosMap(),
      };
    }

    // ---- Colmenas ----
    if(seg[0] === 'hives'){
      if(method === 'POST'){
        const id = uid('h');
        run(`INSERT INTO hives (id, nombre, apiario, ubicacion, alzas, excluidor, created_at) VALUES (?,?,?,?,?,?,?)`,
          [id, body.nombre||'', body.apiario||'', body.ubicacion||'', body.alzas||0, body.excluidor||'No', nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE hives SET nombre=?, apiario=?, ubicacion=?, alzas=?, excluidor=? WHERE id=?`,
          [body.nombre||'', body.apiario||'', body.ubicacion||'', body.alzas||0, body.excluidor||'No', seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM hives WHERE id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Revisiones ----
    if(seg[0] === 'revisions'){
      if(method === 'POST'){
        const id = uid('r');
        run(`INSERT INTO revisions (id, hive_id, fecha, clima, peina, postura, cria, poblacion, reservas, polen,
             plagas, estado, alimentacion, tratamiento, observaciones, cuadros_miel, cuadros_cria, cuadros_operculada, celdas_reales, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, body.hiveId, body.fecha, body.clima, body.peina, body.postura, body.cria, body.poblacion, body.reservas,
           body.polen, body.plagas, body.estado, body.alimentacion, body.tratamiento, body.observaciones,
           body.cuadrosMiel, body.cuadrosCria, body.cuadrosOperculada, body.celdasReales, nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE revisions SET hive_id=?, fecha=?, clima=?, peina=?, postura=?, cria=?, poblacion=?, reservas=?,
             polen=?, plagas=?, estado=?, alimentacion=?, tratamiento=?, observaciones=?,
             cuadros_miel=?, cuadros_cria=?, cuadros_operculada=?, celdas_reales=? WHERE id=?`,
          [body.hiveId, body.fecha, body.clima, body.peina, body.postura, body.cria, body.poblacion, body.reservas,
           body.polen, body.plagas, body.estado, body.alimentacion, body.tratamiento, body.observaciones,
           body.cuadrosMiel, body.cuadrosCria, body.cuadrosOperculada, body.celdasReales, seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM revisions WHERE id=?`, [seg[1]]);
        run(`DELETE FROM photos WHERE entry_type='rev' AND entry_id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Extracciones ----
    if(seg[0] === 'extractions'){
      if(method === 'POST'){
        const id = uid('x');
        run(`INSERT INTO extractions (id, hive_id, fecha, cuadros, kg, humedad, notas, created_at) VALUES (?,?,?,?,?,?,?,?)`,
          [id, body.hiveId, body.fecha, body.cuadros, body.kg, body.humedad, body.notas, nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE extractions SET hive_id=?, fecha=?, cuadros=?, kg=?, humedad=?, notas=? WHERE id=?`,
          [body.hiveId, body.fecha, body.cuadros, body.kg, body.humedad, body.notas, seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM extractions WHERE id=?`, [seg[1]]);
        run(`DELETE FROM photos WHERE entry_type='ext' AND entry_id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Enjambres ----
    if(seg[0] === 'swarms'){
      if(method === 'POST'){
        const id = uid('s');
        run(`INSERT INTO swarms (id, fecha, origen_hive_id, origen_desconocido, capturado, destino_hive_id, notas, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          [id, body.fecha, body.origenHiveId, body.origenDesconocido?1:0, body.capturado, body.destinoHiveId, body.notas, nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE swarms SET fecha=?, origen_hive_id=?, origen_desconocido=?, capturado=?, destino_hive_id=?, notas=? WHERE id=?`,
          [body.fecha, body.origenHiveId, body.origenDesconocido?1:0, body.capturado, body.destinoHiveId, body.notas, seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM swarms WHERE id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Notas ----
    if(seg[0] === 'notes'){
      if(method === 'POST'){
        const id = uid('n');
        run(`INSERT INTO notes (id, fecha, texto, created_at) VALUES (?,?,?,?)`, [id, body.fecha, body.texto||'', nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE notes SET fecha=?, texto=? WHERE id=?`, [body.fecha, body.texto||'', seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM notes WHERE id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Cambios de reina ----
    if(seg[0] === 'queens'){
      if(method === 'POST'){
        const id = uid('q');
        run(`INSERT INTO queen_changes (id, hive_id, fecha, anio_reina, motivo, notas, created_at) VALUES (?,?,?,?,?,?,?)`,
          [id, body.hiveId, body.fecha, body.anioReina, body.motivo, body.notas||'', nowIso()]);
        await _saveDbFile();
        return { id };
      }
      if(method === 'PUT'){
        run(`UPDATE queen_changes SET hive_id=?, fecha=?, anio_reina=?, motivo=?, notas=? WHERE id=?`,
          [body.hiveId, body.fecha, body.anioReina, body.motivo, body.notas||'', seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
      if(method === 'DELETE'){
        run(`DELETE FROM queen_changes WHERE id=?`, [seg[1]]);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Fotos sueltas ----
    if(seg[0] === 'photos' && method === 'DELETE'){
      run(`DELETE FROM photos WHERE id=?`, [seg[1]]);
      await _saveDbFile();
      return { ok: true };
    }

    // ---- Ajustes ----
    if(seg[0] === 'settings'){
      if(method === 'GET'){
        const row = one(`SELECT * FROM settings WHERE id=1`);
        return row ? { lat: row.lat, lon: row.lon, nombre: row.nombre || 'Colmenar Zeta' } : { lat: null, lon: null, nombre: 'Colmenar Zeta' };
      }
      if(method === 'POST'){
        const current = one(`SELECT * FROM settings WHERE id=1`);
        const lat = ('lat' in body) ? body.lat : (current ? current.lat : null);
        const lon = ('lon' in body) ? body.lon : (current ? current.lon : null);
        const nombre = ('nombre' in body) ? body.nombre : (current ? current.nombre : 'Colmenar Zeta');
        const locationChanged = !current || current.lat !== lat || current.lon !== lon;
        run(`INSERT INTO settings (id, lat, lon, nombre, updated_at) VALUES (1,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, nombre=excluded.nombre, updated_at=excluded.updated_at`,
          [lat, lon, nombre, nowIso()]);
        if(locationChanged && ('lat' in body)) run(`DELETE FROM weather_days`);
        await _saveDbFile();
        return { ok: true };
      }
    }

    // ---- Clima ----
    if(seg[0] === 'weather' && seg[1] === 'season'){
      return await getWeatherSeason(seg[2]);
    }

    return { error: 'ruta_no_encontrada' };
  }catch(e){
    console.error('localApi error', path, e);
    return { error: String(e) };
  }
}

async function localImportBackup(file){
  await _readyPromise;
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const dataJsonEntry = zip.file('data.json');

  if(dataJsonEntry){
    // ---- Formato unificado (servidor <-> móvil) ----
    const payload = JSON.parse(await dataJsonEntry.async('string'));

    ['photos','hives','revisions','extractions','swarms','notes','queen_changes'].forEach(t=> run(`DELETE FROM ${t}`));

    (payload.hives||[]).forEach(h=> run(
      `INSERT INTO hives (id, nombre, apiario, ubicacion, alzas, excluidor, created_at) VALUES (?,?,?,?,?,?,?)`,
      [h.id, h.nombre, h.apiario, h.ubicacion, h.alzas, h.excluidor, h.created_at]));

    (payload.revisions||[]).forEach(r=> run(
      `INSERT INTO revisions (id, hive_id, fecha, clima, peina, postura, cria, poblacion, reservas, polen,
       plagas, estado, alimentacion, tratamiento, observaciones, cuadros_miel, cuadros_cria, cuadros_operculada, celdas_reales, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.hive_id, r.fecha, r.clima, r.peina, r.postura, r.cria, r.poblacion, r.reservas, r.polen,
       r.plagas, r.estado, r.alimentacion, r.tratamiento, r.observaciones, r.cuadros_miel, r.cuadros_cria, r.cuadros_operculada, r.celdas_reales, r.created_at]));

    (payload.extractions||[]).forEach(x=> run(
      `INSERT INTO extractions (id, hive_id, fecha, cuadros, kg, humedad, notas, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [x.id, x.hive_id, x.fecha, x.cuadros, x.kg, x.humedad, x.notas, x.created_at]));

    (payload.swarms||[]).forEach(s=> run(
      `INSERT INTO swarms (id, fecha, origen_hive_id, origen_desconocido, capturado, destino_hive_id, notas, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [s.id, s.fecha, s.origen_hive_id, s.origen_desconocido, s.capturado, s.destino_hive_id, s.notas, s.created_at]));

    (payload.notes||[]).forEach(n=> run(
      `INSERT INTO notes (id, fecha, texto, created_at) VALUES (?,?,?,?)`, [n.id, n.fecha, n.texto, n.created_at]));

    (payload.queens||[]).forEach(q=> run(
      `INSERT INTO queen_changes (id, hive_id, fecha, anio_reina, motivo, notas, created_at) VALUES (?,?,?,?,?,?,?)`,
      [q.id, q.hive_id, q.fecha, q.anio_reina, q.motivo, q.notas, q.created_at]));

    for(const p of (payload.photos||[])){
      const entry = zip.file(`photos/${p.file}`);
      if(entry){
        const base64Content = await entry.async('base64');
        run(`INSERT INTO photos (id, entry_type, entry_id, content, created_at) VALUES (?,?,?,?,?)`,
          [p.id, p.entryType, p.entryId, `data:image/jpeg;base64,${base64Content}`, nowIso()]);
      }
    }

    if(payload.settings){
      run(`INSERT INTO settings (id, lat, lon, nombre, updated_at) VALUES (1,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, nombre=excluded.nombre, updated_at=excluded.updated_at`,
        [payload.settings.lat, payload.settings.lon, payload.settings.nombre, nowIso()]);
      run(`DELETE FROM weather_days`);
    }

    await _saveDbFile();
    return;
  }

  // ---- Compatibilidad con copias antiguas exclusivas de Android (solo colmenar.db) ----
  const dbEntry = zip.file('colmenar.db');
  if(!dbEntry) throw new Error('El archivo no parece una copia de seguridad válida');
  const bytes = await dbEntry.async('uint8array');
  _db.close();
  _db = new _SQL.Database(bytes);
  await _saveDbFile();
}

// Arranque automático en cuanto se carga la página
let _readyPromise = initLocalDb().catch(e => console.error('No se pudo iniciar la base de datos local', e));
