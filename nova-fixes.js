/* =====================================================
   NOVA — FIXES v1.0
   Aplica correcciones de bugs sin modificar index.html
   Incluir al final del <body>:
   <script src="nova-fixes.js"></script>
   ===================================================== */

(function() {
'use strict';

/* ─────────────────────────────────────────────────────
   FIX 1: orgCount / recCount / noCount NUNCA SE INCREMENTAN
   addPoints() no los actualiza — parchamos la función
   ───────────────────────────────────────────────────── */
const _origAddPoints = window.addPoints;
window.addPoints = function(points, type, objectName) {
    // Increment per-type counters BEFORE calling original
    if (type === 'organico')               gameData.orgCount = (gameData.orgCount || 0) + 1;
    else if (type === 'inorganico-reciclable') gameData.recCount = (gameData.recCount || 0) + 1;
    else if (type === 'inorganico-no-reciclable') gameData.noCount = (gameData.noCount || 0) + 1;

    _origAddPoints(points, type, objectName);
};

/* ─────────────────────────────────────────────────────
   FIX 2: mapStatusText — elemento faltante en el modal
   El JS busca getElementById('mapStatusText') pero no
   existe en el HTML. Lo creamos dentro del map-header.
   ───────────────────────────────────────────────────── */
function ensureMapStatusEl() {
    if (document.getElementById('mapStatusText')) return;
    const headerText = document.querySelector('.map-header-text');
    if (!headerText) return;
    const p = document.createElement('p');
    p.id = 'mapStatusText';
    p.style.cssText = 'font-size:0.74em;color:var(--t3);margin-top:1px';
    p.textContent = 'Listo para buscar puntos de reciclaje';
    headerText.appendChild(p);
}

/* ─────────────────────────────────────────────────────
   FIX 3: openMapModal DUPLICADA — usar sólo la versión
   async que carga Leaflet de forma lazy
   ───────────────────────────────────────────────────── */
window.openMapModal = async function() {
    ensureMapStatusEl();
    document.getElementById('mapModal').classList.add('active');
    if (!window.novaMap) {
        const statusEl = document.getElementById('mapStatusText');
        if (statusEl) statusEl.textContent = 'Cargando mapa...';
        await ensureLeaflet();
        setTimeout(initMap, 100);
    }
};

/* ─────────────────────────────────────────────────────
   FIX 4: initFirebase TRIPLICADA — sólo una versión real
   Las 3 definiciones anteriores se cancelan entre sí.
   La versión lazy (ensureFirebaseReady) es la correcta,
   pero nunca se llama al inicio. La fijamos para que
   se intente en background sin bloquear.
   ───────────────────────────────────────────────────── */
window.initFirebase = async function() {
    try {
        await ensureFirebaseReady();
    } catch(e) {
        console.warn('Firebase background init:', e.message);
    }
};

/* ─────────────────────────────────────────────────────
   FIX 5: map-filter-btn — clase active-blue no existe
   Los filtros de mapa usaban .active-blue en el HTML
   pero el CSS solo define .active. Normalizamos a .active
   y agregamos el color correcto por data-filter.
   ───────────────────────────────────────────────────── */
window.filterMapPoints = function(btn, filter) {
    window.activeMapFilter = filter;
    document.querySelectorAll('.map-filter-btn').forEach(b => {
        b.classList.remove('active', 'active-blue');
    });
    btn.classList.add('active');
    // Color por tipo
    const colors = {
        recycling: { bg: 'rgba(34,211,238,0.15)', color: '#22d3ee', border: 'rgba(34,211,238,0.5)' },
        organic:   { bg: 'rgba(61,186,122,0.15)', color: 'var(--green-1)', border: 'rgba(61,186,122,0.5)' },
        hazard:    { bg: 'rgba(248,113,113,0.15)', color: '#f87171', border: 'rgba(248,113,113,0.5)' },
        all:       { bg: 'var(--green-1)', color: '#030d03', border: 'var(--green-1)' }
    };
    const c = colors[filter];
    if (c) {
        btn.style.background = c.bg;
        btn.style.color = c.color;
        btn.style.borderColor = c.border;
    }
    if (window.novaMap) fetchRecyclingPoints(window.userLatLng || [19.4326, -99.1332]);
};

/* ─────────────────────────────────────────────────────
   FIX 6: MAPA — radio 5km + query Overpass más completa
   La query original solo buscaba amenity=recycling en 2km
   Ampliamos a 5km e incluimos más tipos de puntos.
   ───────────────────────────────────────────────────── */
window.fetchRecyclingPoints = async function(center) {
    const statusEl = document.getElementById('mapStatusText');
    if (statusEl) statusEl.textContent = 'Buscando puntos de reciclaje...';

    const [lat, lon] = center;
    const radius = 5000; // 5km (era 2km)

    // Query Overpass ampliada: incluye más tipos de puntos
    const query = `[out:json][timeout:20];
(
  node["amenity"="recycling"](around:${radius},${lat},${lon});
  node["recycling_type"="container"](around:${radius},${lat},${lon});
  node["amenity"="waste_disposal"](around:${radius},${lat},${lon});
  node["amenity"="waste_transfer_station"](around:${radius},${lat},${lon});
  node["recycling:paper"="yes"](around:${radius},${lat},${lon});
  node["recycling:glass"="yes"](around:${radius},${lat},${lon});
  node["recycling:plastic"="yes"](around:${radius},${lat},${lon});
  node["recycling:metal"="yes"](around:${radius},${lat},${lon});
  node["recycling:clothes"="yes"](around:${radius},${lat},${lon});
  node["recycling:organic"="yes"](around:${radius},${lat},${lon});
  node["composting"="yes"](around:${radius},${lat},${lon});
  way["amenity"="recycling"](around:${radius},${lat},${lon});
  way["recycling_type"="centre"](around:${radius},${lat},${lon});
)
out center body;`;

    try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            signal: AbortSignal.timeout(18000)
        });

        if (!res.ok) throw new Error('Overpass error: ' + res.status);

        const data = await res.json();
        const elements = (data.elements || []).map(el => {
            // Normalizar ways (tienen center.lat/lon)
            if (el.type === 'way' && el.center) {
                return { ...el, lat: el.center.lat, lon: el.center.lon };
            }
            return el;
        }).filter(el => el.lat && el.lon);

        renderMapPoints(elements);

        if (statusEl) {
            const count = elements.length;
            statusEl.textContent = count > 0
                ? `${count} punto${count > 1 ? 's' : ''} encontrado${count > 1 ? 's' : ''} en 5 km`
                : 'Sin puntos en esta zona — prueba ampliar el mapa';
        }
    } catch(e) {
        console.warn('Overpass error, usando ejemplos:', e.message);
        if (statusEl) statusEl.textContent = 'Sin conexión — mostrando ejemplos ilustrativos';
        renderMapPoints(generateExamplePoints(lat, lon));
    }
};

/* ─────────────────────────────────────────────────────
   FIX 7: result-flip-back no tiene altura — el padre
   .result-flip-inner colapsa. Parchamos wrapResultInFlipCard
   para forzar min-height en el inner.
   ───────────────────────────────────────────────────── */
const _origWrap = window.wrapResultInFlipCard;
window.wrapResultInFlipCard = function(resultEl, info) {
    _origWrap(resultEl, info);
    // Después del wrap, asegurar que el inner tenga altura mínima
    setTimeout(() => {
        document.querySelectorAll('.result-flip-inner').forEach(inner => {
            if (!inner.style.minHeight) {
                const front = inner.querySelector('.result-flip-front');
                if (front) inner.style.minHeight = front.offsetHeight + 'px';
            }
        });
    }, 100);
};

/* ─────────────────────────────────────────────────────
   FIX 8: historial — history-export-btn usa inline
   onmouseover con var() que no resuelve en atributos HTML.
   Reemplazamos los handlers por event listeners.
   ───────────────────────────────────────────────────── */
function fixExportBtn() {
    const btn = document.querySelector('.history-export-btn');
    if (!btn) return;
    btn.removeAttribute('onmouseover');
    btn.removeAttribute('onmouseout');
    btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = 'var(--border-mid)';
        btn.style.color = 'var(--t2)';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = 'var(--border-subtle)';
        btn.style.color = 'var(--t3)';
    });
}

/* ─────────────────────────────────────────────────────
   FIX 9: offline-badge — SVG malformado con style dentro
   del atributo que cierra el tag prematuramente.
   Lo reconstruimos limpio.
   ───────────────────────────────────────────────────── */
function fixOfflineBadge() {
    const badge = document.getElementById('offlineBadge');
    if (!badge) return;
    badge.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:5px;flex-shrink:0"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg> Modo sin conexión · Funciones básicas activas`;
}

/* ─────────────────────────────────────────────────────
   FIX 10: hms-label spans con `;` en lugar de espacio
   Algunos spans tienen class="" que no se parsea bien.
   Los reconstruimos desde renderHistory.
   ───────────────────────────────────────────────────── */
const _origRenderHistory = window.renderHistory;
window.renderHistory = function() {
    _origRenderHistory && _origRenderHistory();
    // Corregir los hms-labels después del render
    const labels = document.querySelectorAll('.hms-label');
    labels.forEach(lbl => {
        // Fix broken span inside label if present
        const broken = lbl.querySelector('span[style*="width:10px"]');
        if (broken && broken.style.display !== 'inline-block') {
            broken.style.display = 'inline-block';
            broken.style.flexShrink = '0';
            broken.style.verticalAlign = 'middle';
        }
    });
    fixExportBtn();
};

/* ─────────────────────────────────────────────────────
   FIX 11: Inicialización — llamar fixOfflineBadge y
   ensureMapStatusEl al cargar, y asegurar que el mapa
   tenga el elemento status antes de abrirse.
   ───────────────────────────────────────────────────── */
function applyDomFixes() {
    fixOfflineBadge();
    fixExportBtn();
    // Corregir name-submit-btn si le falta estilos
    const submitBtn = document.querySelector('.name-submit-btn');
    if (submitBtn) {
        submitBtn.style.width = submitBtn.style.width || '100%';
        if (!submitBtn.style.display) {
            submitBtn.style.display = 'flex';
            submitBtn.style.alignItems = 'center';
            submitBtn.style.justifyContent = 'center';
            submitBtn.style.gap = '8px';
        }
        // Si no tiene background (no heredó el CSS)
        const computed = getComputedStyle(submitBtn).background;
        if (!computed || computed === 'none' || computed === 'rgba(0, 0, 0, 0)') {
            submitBtn.style.background = 'linear-gradient(135deg, var(--green-1), var(--green-2))';
            submitBtn.style.color = '#030d03';
            submitBtn.style.border = 'none';
            submitBtn.style.borderRadius = 'var(--r-md)';
            submitBtn.style.padding = '14px';
            submitBtn.style.fontFamily = "'DM Sans', sans-serif";
            submitBtn.style.fontSize = '0.95em';
            submitBtn.style.fontWeight = '700';
            submitBtn.style.cursor = 'pointer';
            submitBtn.style.marginTop = '12px';
        }
    }
}

// Aplicar fixes después de que el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyDomFixes);
} else {
    // DOM ya listo, pero esperar a que window.onload termine
    setTimeout(applyDomFixes, 300);
}

/* ─────────────────────────────────────────────────────
   FIX 12: Abrir modal del mapa — asegurar que el
   elemento mapStatusText exista antes de que initMap()
   lo busque.
   ───────────────────────────────────────────────────── */
const _origInitMap = window.initMap;
window.initMap = function() {
    ensureMapStatusEl();
    _origInitMap && _origInitMap();
};

console.info('✅ Nova fixes v1.0 aplicados');

})(); // end IIFE
