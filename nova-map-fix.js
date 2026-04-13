/* =====================================================
   NOVA — MAP FIX COMPLETO v2.0
   Reemplaza nova-fixes.js o agregar después de él.
   Soluciona: mapa negro, falsa desconexión, Leaflet
   timing, Overpass CORS, y ejemplos ilustrativos.
   ===================================================== */

(function() {
'use strict';

/* ─────────────────────────────────────────────────────
   CONSTANTES
   ───────────────────────────────────────────────────── */
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

// Servidores Overpass alternativos (el oficial a veces bloquea por CORS)
const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

/* ─────────────────────────────────────────────────────
   ESTADO DEL MAPA (reemplaza variables globales)
   ───────────────────────────────────────────────────── */
let _map         = null;
let _markers     = [];
let _userMarker  = null;
let _userLatLng  = null;
let _mapFilter   = 'all';
let _leafletReady = false;
let _allPoints   = []; // cache de puntos cargados

/* ─────────────────────────────────────────────────────
   LOADER DE LEAFLET — espera a que CSS Y JS estén listos
   ───────────────────────────────────────────────────── */
function loadLeaflet() {
    return new Promise((resolve) => {
        if (typeof L !== 'undefined' && _leafletReady) { resolve(); return; }

        // CSS primero
        if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            link.href = LEAFLET_CSS;
            document.head.appendChild(link);
        }

        if (typeof L !== 'undefined') {
            _leafletReady = true;
            resolve();
            return;
        }

        // JS de Leaflet
        const script = document.createElement('script');
        script.src = LEAFLET_JS;
        script.onload = () => {
            // Esperar 100ms extra para que el CSS aplique
            setTimeout(() => {
                _leafletReady = true;
                resolve();
            }, 120);
        };
        script.onerror = () => {
            // Fallback: intentar cdnjs
            const s2 = document.createElement('script');
            s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
            s2.onload = () => { _leafletReady = true; resolve(); };
            s2.onerror = resolve; // resolver igual para no bloquear
            document.head.appendChild(s2);
        };
        document.head.appendChild(script);
    });
}

/* ─────────────────────────────────────────────────────
   DETECTOR DE CONECTIVIDAD REAL
   navigator.onLine miente — verificamos con un fetch real
   ───────────────────────────────────────────────────── */
async function isReallyOnline() {
    // navigator.onLine = false → definitivamente offline
    if (!navigator.onLine) return false;

    // Verificar con un recurso ligero (favicon de OpenStreetMap)
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        await fetch('https://tile.openstreetmap.org/favicon.ico', {
            method: 'HEAD',
            mode:   'no-cors',
            cache:  'no-store',
            signal: controller.signal
        });
        clearTimeout(timeout);
        return true;
    } catch {
        // Intentar un segundo recurso
        try {
            await fetch('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/package.json', {
                method: 'HEAD', mode: 'no-cors', cache: 'no-store',
                signal: AbortSignal.timeout(3000)
            });
            return true;
        } catch {
            return false;
        }
    }
}

/* ─────────────────────────────────────────────────────
   FETCH CON MÚLTIPLES MIRRORS DE OVERPASS
   ───────────────────────────────────────────────────── */
async function fetchOverpass(query) {
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const res = await fetch(mirror, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!res.ok) continue; // probar siguiente mirror

            const data = await res.json();
            if (data && data.elements) return data;
        } catch (e) {
            console.warn('Overpass mirror falló:', mirror, e.message);
            // Continuar con el siguiente mirror
        }
    }
    throw new Error('Todos los mirrors de Overpass fallaron');
}

/* ─────────────────────────────────────────────────────
   QUERY OVERPASS — 5km, tipos completos
   ───────────────────────────────────────────────────── */
function buildOverpassQuery(lat, lon, radius = 5000) {
    return `[out:json][timeout:25];
(
  node["amenity"="recycling"](around:${radius},${lat},${lon});
  node["recycling_type"~"container|centre"](around:${radius},${lat},${lon});
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
  way["recycling_type"~"container|centre"](around:${radius},${lat},${lon});
)
out center body;`;
}

/* ─────────────────────────────────────────────────────
   TIPO DE PUNTO — detección mejorada
   ───────────────────────────────────────────────────── */
function detectPointType(tags) {
    if (!tags) return 'recycling';
    if (tags._novaType) return tags._novaType;
    const organic = ['composting','recycling:organic','recycling:food_waste'];
    if (organic.some(k => tags[k] === 'yes') || tags.amenity === 'composting') return 'organic';
    const hazard = ['recycling:batteries','recycling:electrical_items',
                    'recycling:small_electrical_appliances','recycling:paint',
                    'recycling:fluorescent_tubes','recycling:hazardous'];
    if (hazard.some(k => tags[k] === 'yes') || tags.amenity === 'waste_transfer_station') return 'hazard';
    return 'recycling';
}

/* ─────────────────────────────────────────────────────
   GÉNERAR PUNTOS ILUSTRATIVOS (sin conexión)
   ───────────────────────────────────────────────────── */
function generateExamplePoints(lat, lon) {
    const seed = [
        { dx: 0.008, dy: 0.005, name: 'Centro de Reciclaje Norte', type: 'recycling' },
        { dx:-0.006, dy: 0.010, name: 'Contenedor Plaza Central', type: 'recycling' },
        { dx: 0.012, dy:-0.008, name: 'Compostera Parque Sur', type: 'organic' },
        { dx:-0.010, dy:-0.005, name: 'Acopio Especial Municipio', type: 'hazard' },
        { dx: 0.002, dy: 0.015, name: 'Reciclaje Colonia Este', type: 'recycling' },
        { dx:-0.014, dy: 0.003, name: 'Punto Limpio Mercado', type: 'recycling' },
    ];
    return seed.map((p, i) => ({
        id: i, lat: lat + p.dx, lon: lon + p.dy,
        tags: { name: p.name, _novaType: p.type, amenity: 'recycling' }
    }));
}

/* ─────────────────────────────────────────────────────
   ÍCONO DE MARCADOR SVG EMBEBIDO (no depende de imgs)
   ───────────────────────────────────────────────────── */
function makeIcon(type) {
    const cfg = {
        recycling: { color: '#22d3ee', ring: 'rgba(34,211,238,0.25)',
            svg: '<path d="M12 2L6.5 11h11L12 2z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 11L3 20h18l-3.5-9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 20l1.5-5 1.5 5" stroke-width="1.5" stroke-linecap="round"/>' },
        organic:   { color: '#3dba7a', ring: 'rgba(61,186,122,0.25)',
            svg: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" stroke-width="1.5" stroke-linecap="round"/>' },
        hazard:    { color: '#f87171', ring: 'rgba(248,113,113,0.25)',
            svg: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/>' }
    };
    const c = cfg[type] || cfg.recycling;
    const html = `
        <div style="position:relative;width:36px;height:42px;cursor:pointer">
            <div style="
                position:absolute;bottom:0;left:50%;transform:translateX(-50%);
                width:36px;height:36px;border-radius:50% 50% 50% 0;
                transform:translateX(-50%) rotate(-45deg);
                background:${c.color};
                box-shadow:0 3px 12px ${c.ring},0 0 0 3px ${c.ring};
                display:flex;align-items:center;justify-content:center;
            ">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                     stroke="#fff" stroke-width="1.8" stroke-linecap="round"
                     style="transform:rotate(45deg)">
                    ${c.svg}
                </svg>
            </div>
            <div style="
                position:absolute;bottom:-3px;left:50%;
                transform:translateX(-50%);
                width:8px;height:8px;border-radius:50%;
                background:${c.color};opacity:0.6;
            "></div>
        </div>`;

    return L.divIcon({
        className: '',
        html,
        iconSize:   [36, 42],
        iconAnchor: [18, 42],
        popupAnchor:[0, -46]
    });
}

/* ─────────────────────────────────────────────────────
   RENDERIZAR PUNTOS EN EL MAPA
   ───────────────────────────────────────────────────── */
function renderPoints(points) {
    if (!_map) return;

    // Limpiar marcadores anteriores
    _markers.forEach(m => m.remove());
    _markers = [];

    const visible = _mapFilter === 'all'
        ? points
        : points.filter(p => detectPointType(p.tags) === _mapFilter);

    visible.forEach(el => {
        const type = detectPointType(el.tags || {});
        const name = el.tags?.name || el.tags?.operator || 'Punto de reciclaje';
        const latlng = [el.lat, el.lon];

        const typeLabels = { recycling: 'Reciclable', organic: 'Orgánico', hazard: 'Especial/Peligroso' };
        const typeColors = { recycling: '#22d3ee', organic: '#3dba7a', hazard: '#f87171' };

        let dist = '';
        if (_userLatLng && _map) {
            try {
                const d = _map.distance(_userLatLng, latlng);
                dist = d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km';
            } catch {}
        }

        // Detalles de materiales aceptados
        const accepted = [];
        const t = el.tags || {};
        if (t['recycling:paper']   === 'yes') accepted.push('📄 Papel');
        if (t['recycling:glass']   === 'yes') accepted.push('🫙 Vidrio');
        if (t['recycling:plastic'] === 'yes') accepted.push('🧴 Plástico');
        if (t['recycling:metal']   === 'yes') accepted.push('🥫 Metal');
        if (t['recycling:organic'] === 'yes') accepted.push('🌱 Orgánico');
        if (t['recycling:clothes'] === 'yes') accepted.push('👕 Ropa');

        const acceptedHtml = accepted.length > 0
            ? `<div style="margin-top:6px;font-size:11px;color:#666;line-height:1.8">${accepted.join(' · ')}</div>`
            : '';

        const popupContent = `
            <div style="font-family:'DM Sans',system-ui,sans-serif;padding:2px;min-width:180px">
                <div style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;
                            margin-bottom:6px;background:${typeColors[type]}22;color:${typeColors[type]}">
                    ${typeLabels[type] || 'Reciclaje'}
                </div>
                <div style="font-weight:600;font-size:13px;color:#111;margin-bottom:4px">${name}</div>
                ${dist ? `<div style="font-size:11px;color:#888">📍 ${dist} de ti</div>` : ''}
                ${acceptedHtml}
            </div>`;

        try {
            const m = L.marker(latlng, { icon: makeIcon(type) }).addTo(_map);
            m.bindPopup(popupContent, {
                maxWidth: 220,
                className: 'nova-popup'
            });
            _markers.push(m);
        } catch(e) {
            console.warn('Error añadiendo marcador:', e);
        }
    });

    return _markers.length;
}

/* ─────────────────────────────────────────────────────
   INIT MAP — con retry y validación de tamaño
   ───────────────────────────────────────────────────── */
function initNovaMap() {
    if (_map) {
        _map.invalidateSize();
        return;
    }

    const container = document.getElementById('novaMap');
    if (!container) return;

    // Forzar tamaño mínimo visible
    container.style.minHeight = '300px';
    container.style.height    = container.style.height || '100%';
    container.style.flex      = '1';
    container.style.display   = 'block';

    try {
        // Ciudad de México como fallback
        const defaultCenter = [19.4326, -99.1332];

        _map = L.map('novaMap', {
            zoomControl: false,
            attributionControl: true
        }).setView(defaultCenter, 13);

        // Tiles con fallback
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
            maxZoom: 19,
            crossOrigin: true
        }).addTo(_map);

        L.control.zoom({ position: 'bottomleft' }).addTo(_map);

        // Forzar redraw después de que el DOM esté estable
        setTimeout(() => {
            if (_map) _map.invalidateSize(true);
        }, 250);

        // Exponer para compatibilidad con el código original
        window.novaMap = _map;

        // Geolocalización
        setMapStatus('Obteniendo tu ubicación...');

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                pos => {
                    _userLatLng = [pos.coords.latitude, pos.coords.longitude];
                    window.userLatLng = _userLatLng;
                    _map.setView(_userLatLng, 15);
                    _map.invalidateSize(true);

                    // Marcador de usuario
                    if (_userMarker) _userMarker.remove();
                    const userIcon = L.divIcon({
                        className: '',
                        html: `<div style="width:18px;height:18px;border-radius:50%;background:#3dba7a;border:3px solid #fff;box-shadow:0 0 0 4px rgba(61,186,122,0.3),0 2px 8px rgba(0,0,0,0.4)"></div>`,
                        iconSize: [18, 18], iconAnchor: [9, 9]
                    });
                    _userMarker = L.marker(_userLatLng, { icon: userIcon, zIndexOffset: 1000 }).addTo(_map);
                    _userMarker.bindPopup('<b style="font-size:13px">📍 Tu ubicación</b>');

                    loadRecyclingPoints(_userLatLng);
                },
                (err) => {
                    console.warn('Geoloc error:', err.message);
                    setMapStatus('Ubicación no disponible — mostrando Ciudad de México');
                    loadRecyclingPoints(defaultCenter);
                },
                { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
            );
        } else {
            setMapStatus('GPS no disponible — mostrando Ciudad de México');
            loadRecyclingPoints(defaultCenter);
        }

    } catch(e) {
        console.error('Error inicializando mapa:', e);
        setMapStatus('Error al cargar el mapa — recarga la página');
    }
}

/* ─────────────────────────────────────────────────────
   CARGAR PUNTOS DE RECICLAJE — con fallback real
   ───────────────────────────────────────────────────── */
async function loadRecyclingPoints(center) {
    const [lat, lon] = center;

    setMapStatus('Verificando conexión...');

    const online = await isReallyOnline();

    if (!online) {
        setMapStatus('Sin conexión — mostrando puntos ilustrativos');
        _allPoints = generateExamplePoints(lat, lon);
        const count = renderPoints(_allPoints);
        if (count > 0 && _map) {
            const group = L.featureGroup(_markers);
            _map.fitBounds(group.getBounds().pad(0.2));
        }
        return;
    }

    setMapStatus('Buscando puntos de reciclaje (5 km)...');

    try {
        const query = buildOverpassQuery(lat, lon, 5000);
        const data  = await fetchOverpass(query);

        // Normalizar ways (tienen center en vez de lat/lon directos)
        _allPoints = (data.elements || [])
            .map(el => {
                if (el.type === 'way' && el.center) {
                    return { ...el, lat: el.center.lat, lon: el.center.lon };
                }
                return el;
            })
            .filter(el => el.lat && el.lon);

        if (_allPoints.length === 0) {
            // No hay puntos registrados → mostrar ejemplos y avisar
            setMapStatus('Sin puntos registrados en OSM para esta zona');
            _allPoints = generateExamplePoints(lat, lon);
            const count = renderPoints(_allPoints);
            if (count > 0 && _map) {
                const group = L.featureGroup(_markers);
                _map.fitBounds(group.getBounds().pad(0.3));
            }
            return;
        }

        const count = renderPoints(_allPoints);
        setMapStatus(`${count} punto${count !== 1 ? 's' : ''} encontrado${count !== 1 ? 's' : ''} en 5 km`);

        // Ajustar vista a los marcadores
        if (count > 0 && _map) {
            const group = L.featureGroup(_markers);
            try {
                _map.fitBounds(group.getBounds().pad(0.15), { maxZoom: 15 });
            } catch {}
        }

    } catch(e) {
        console.warn('Overpass completo falló:', e.message);
        setMapStatus('Error de red — mostrando puntos ilustrativos');
        _allPoints = generateExamplePoints(lat, lon);
        renderPoints(_allPoints);
    }
}

/* ─────────────────────────────────────────────────────
   HELPER — actualizar status text del mapa
   ───────────────────────────────────────────────────── */
function setMapStatus(text) {
    const el = document.getElementById('mapStatusText');
    if (el) el.textContent = text;
}

/* ─────────────────────────────────────────────────────
   FILTRAR PUNTOS — reemplaza la función global
   ───────────────────────────────────────────────────── */
window.filterMapPoints = function(btn, filter) {
    _mapFilter = filter;
    window.activeMapFilter = filter;

    document.querySelectorAll('.map-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background   = '';
        b.style.color        = '';
        b.style.borderColor  = '';
        b.style.fontWeight   = '';
    });

    btn.classList.add('active');

    const colors = {
        recycling: { bg: 'rgba(34,211,238,0.2)', color: '#22d3ee',   border: 'rgba(34,211,238,0.55)' },
        organic:   { bg: 'rgba(61,186,122,0.2)', color: '#3dba7a',   border: 'rgba(61,186,122,0.55)' },
        hazard:    { bg: 'rgba(248,113,113,0.2)', color: '#f87171',  border: 'rgba(248,113,113,0.55)' },
        all:       { bg: 'var(--green-1)',         color: '#030d03',  border: 'var(--green-1)' }
    };
    const c = colors[filter] || colors.all;
    btn.style.background  = c.bg;
    btn.style.color       = c.color;
    btn.style.borderColor = c.border;
    btn.style.fontWeight  = '700';

    // Renderizar con el filtro nuevo usando los puntos cacheados
    if (_allPoints.length > 0) {
        const count = renderPoints(_allPoints);
        setMapStatus(filter === 'all'
            ? `${count} punto${count !== 1 ? 's' : ''} mostrado${count !== 1 ? 's' : ''}`
            : `${count} punto${count !== 1 ? 's' : ''} de tipo "${filter}" encontrado${count !== 1 ? 's' : ''}`
        );
    }
};

/* ─────────────────────────────────────────────────────
   CENTRAR EN USUARIO
   ───────────────────────────────────────────────────── */
window.centerMapOnUser = function() {
    if (_userLatLng && _map) {
        _map.setView(_userLatLng, 16);
        _map.invalidateSize();
    }
};

/* ─────────────────────────────────────────────────────
   ABRIR MODAL DEL MAPA — versión definitiva
   ───────────────────────────────────────────────────── */
window.openMapModal = async function() {
    const modal = document.getElementById('mapModal');
    if (modal) modal.classList.add('active');

    // Asegurar que mapStatusText exista
    if (!document.getElementById('mapStatusText')) {
        const headerText = document.querySelector('.map-header-text');
        if (headerText) {
            const p = document.createElement('p');
            p.id = 'mapStatusText';
            p.style.cssText = 'font-size:0.74em;color:var(--t3);margin-top:1px';
            p.textContent = 'Iniciando...';
            headerText.appendChild(p);
        }
    }

    setMapStatus('Cargando Leaflet...');

    // Cargar Leaflet si no está listo
    await loadLeaflet();

    // Esperar a que el modal sea visible (necesario para dimensiones)
    await new Promise(r => setTimeout(r, 150));

    if (!_map) {
        initNovaMap();
    } else {
        // Mapa ya existe — solo refrescar tamaño
        _map.invalidateSize(true);
    }
};

/* ─────────────────────────────────────────────────────
   CERRAR MODAL
   ───────────────────────────────────────────────────── */
window.closeMapModal = function() {
    const modal = document.getElementById('mapModal');
    if (modal) modal.classList.remove('active');
};

/* ─────────────────────────────────────────────────────
   ESTILOS INLINE DEL POPUP DE LEAFLET
   ───────────────────────────────────────────────────── */
function injectMapStyles() {
    if (document.getElementById('nova-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'nova-map-styles';
    style.textContent = `
        .nova-popup .leaflet-popup-content-wrapper {
            background: rgba(5,14,5,0.97) !important;
            border: 1px solid rgba(61,186,122,0.3) !important;
            border-radius: 12px !important;
            color: #dff2df !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
            backdrop-filter: blur(12px) !important;
        }
        .nova-popup .leaflet-popup-tip {
            background: rgba(5,14,5,0.97) !important;
        }
        .nova-popup .leaflet-popup-content {
            margin: 10px 14px !important;
        }
        /* Tiles más oscuros para el tema dark */
        body:not(.dark-mode) .leaflet-tile {
            filter: none;
        }
        body.dark-mode .leaflet-tile {
            filter: invert(1) hue-rotate(180deg) brightness(0.8) saturate(0.6);
        }
        /* Asegurar que el contenedor del mapa tenga altura */
        #novaMap {
            min-height: 300px !important;
            background: #1a2e1a;
        }
        .leaflet-container {
            background: #1a2e1a !important;
            font-family: 'DM Sans', system-ui, sans-serif !important;
        }
        /* Arreglar z-index de controles */
        .leaflet-top, .leaflet-bottom {
            z-index: 400 !important;
        }
    `;
    document.head.appendChild(style);
}

/* ─────────────────────────────────────────────────────
   INIT — inyectar estilos al cargar
   ───────────────────────────────────────────────────── */
injectMapStyles();

// Invalidar tamaño del mapa cuando el modal se abra con animación
const mapModal = document.getElementById('mapModal');
if (mapModal) {
    const observer = new MutationObserver(() => {
        if (mapModal.classList.contains('active') && _map) {
            setTimeout(() => _map.invalidateSize(true), 300);
        }
    });
    observer.observe(mapModal, { attributes: true, attributeFilter: ['class'] });
}

console.info('✅ Nova Map Fix v2.0 cargado');

})();
