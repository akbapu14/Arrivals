// Widebody aircraft type codes
const WIDEBODY_TYPES = new Set([
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
]);

// Load saved preferences from localStorage
function loadPreferences() {
    try {
        const saved = localStorage.getItem('avgeek_preferences');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.warn('Could not load preferences:', e);
    }
    return {};
}

function savePreferences() {
    try {
        localStorage.setItem('avgeek_preferences', JSON.stringify({
            airport: currentAirport,
            filter: currentFilter,
            view: currentView,
            showAllAircraft: showAllAircraft
        }));
    } catch (e) {
        console.warn('Could not save preferences:', e);
    }
}

const savedPrefs = loadPreferences();

// State
let allArrivals = [];
let currentFilter = savedPrefs.filter || 'upcoming';
let currentAirport = savedPrefs.airport || 'SFO';
let lastRefreshTime = Date.now();
let isLoading = false;
let approachMode = false;
let refreshTimer = null;
let showAllAircraft = savedPrefs.showAllAircraft || false;
let currentView = savedPrefs.view || 'list';
let map = null;
let mapMarkers = [];
let airportMarker = null;
let miniMap = null; // Track mini map instance for cleanup
const NORMAL_INTERVAL = 60; // seconds
const APPROACH_INTERVAL = 1; // seconds when aircraft on approach
const APPROACH_ALTITUDE = 30000; // feet

// Airport coordinates for map centering
const AIRPORT_COORDS = {
    'SFO': [37.6213, -122.3790],
    'LAX': [33.9425, -118.4081],
    'JFK': [40.6413, -73.7781],
    'EWR': [40.6895, -74.1745],
    'DFW': [32.8998, -97.0403],
    'SAN': [32.7338, -117.1933],
    'ORD': [41.9742, -87.9073],
    'ATL': [33.6407, -84.4277],
    'SEA': [47.4502, -122.3088],
    'BOS': [42.3656, -71.0096],
    'MIA': [25.7959, -80.2870],
    'DEN': [39.8561, -104.6737],
};

// Fetch schedule from server
async function fetchSchedule() {
    const response = await fetch(`/api/schedule?airport=${currentAirport}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.arrivals || [];
}

// Filter aircraft by type
function filterAircraft(arrivals) {
    if (showAllAircraft) return arrivals;
    return arrivals.filter(a => WIDEBODY_TYPES.has(a.type));
}

// Format time from Unix timestamp
function formatTime(ts) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

// Format ETA as countdown
function formatETA(ts) {
    if (!ts) return '-';
    const now = Date.now();
    const eta = ts * 1000;
    const diff = eta - now;

    if (diff < 0) return 'Arrived';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((diff % (1000 * 60)) / 1000);

    if (hours > 0) return `${hours}h ${mins}m`;
    // Show MM:SS format for flights under 1 hour
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Get status class
function getStatusClass(color) {
    if (color === 'green') return 'status-green';
    if (color === 'yellow') return 'status-yellow';
    if (color === 'red') return 'status-red';
    return 'status-gray';
}

// Check if flight is landed
function isLanded(arrival) {
    return arrival.status?.toLowerCase().includes('landed');
}


// Check if flight is airborne
function isAirborne(arrival) {
    return arrival.live === true;
}

// Check if flight is upcoming
function isUpcoming(arrival) {
    if (isLanded(arrival)) return false;
    const eta = arrival.eta;
    if (!eta) return true;
    return eta * 1000 > Date.now();
}

// Format altitude
function formatAltitude(ft) {
    if (!ft || ft <= 0) return '-';
    return `${Math.round(ft).toLocaleString()} ft`;
}

// Render flight card
function renderFlightCard(arrival) {
    const landed = isLanded(arrival);
    const live = isAirborne(arrival);
    const clickable = live && arrival.flightId;

    let cardClass = 'flight-card';
    if (live) cardClass += ' live';
    if (landed) cardClass += ' landed';
    if (clickable) cardClass += ' clickable';

    const statusClass = getStatusClass(arrival.statusColor);
    const typeName = arrival.typeName || arrival.type;
    const clickHandler = clickable ? `onclick="openFlightModal('${arrival.flightId}', '${arrival.flight}')"` : '';

    // Show altitude for live flights
    const altitudeHtml = live && arrival.altitude ? `
        <div class="detail">
            <span class="detail-label">Altitude</span>
            <span class="detail-value altitude">${formatAltitude(arrival.altitude)}</span>
        </div>
    ` : '';

    // For landed flights, show landed time instead of ETA
    const etaLabel = landed ? 'Landed' : 'ETA';
    const etaValue = landed ? (arrival.status?.replace(/landed\s*/i, '') || '-') : formatTime(arrival.eta);
    const countdownHtml = landed ? '' : `
        <div class="detail">
            <span class="detail-label">In</span>
            <span class="detail-value eta-countdown" data-eta="${arrival.eta || ''}">${formatETA(arrival.eta)}</span>
        </div>`;

    return `
        <div class="${cardClass}" ${clickHandler}>
            <div class="flight-header">
                <div>
                    <span class="flight-number">${arrival.flight}</span>
                    ${live ? '<span class="status-badge status-green">LIVE</span>' : ''}
                </div>
                <span class="aircraft-type">${typeName}</span>
            </div>
            <div class="flight-details">
                <div class="detail">
                    <span class="detail-label">${etaLabel}</span>
                    <span class="detail-value eta">${etaValue}</span>
                </div>
                ${countdownHtml}
                <div class="detail">
                    <span class="detail-label">From</span>
                    <span class="detail-value origin">${arrival.origin}</span>
                </div>
                ${altitudeHtml}
                ${!altitudeHtml && !landed ? `<div class="detail">
                    <span class="detail-label">Status</span>
                    <span class="detail-value"><span class="status-badge ${statusClass}">${arrival.status || 'Scheduled'}</span></span>
                </div>` : ''}
                <div class="detail" style="grid-column: span 2;">
                    <span class="detail-label">Origin</span>
                    <span class="detail-value" style="font-size: 0.9rem; color: #888;">${arrival.originName || ''}</span>
                </div>
            </div>
        </div>
    `;
}

// Apply filter
function applyFilter(arrivals) {
    switch (currentFilter) {
        case 'upcoming':
            return arrivals.filter(isUpcoming);
        case 'landed':
            return arrivals.filter(isLanded);
        default:
            return arrivals;
    }
}

// Update display
function updateDisplay() {
    const container = document.getElementById('flights-container');
    const totalCount = document.getElementById('total-count');
    const airborneCount = document.getElementById('airborne-count');
    const nextEta = document.getElementById('next-eta');
    const lastUpdate = document.getElementById('last-update');

    const widebodies = filterAircraft(allArrivals);
    const upcoming = widebodies.filter(isUpcoming);
    const airborne = widebodies.filter(isAirborne);

    // Update stats
    totalCount.textContent = widebodies.length;
    airborneCount.textContent = airborne.length;
    lastUpdate.textContent = new Date().toLocaleTimeString();

    // Next arrival
    const nextFlight = upcoming.find(a => a.eta);
    nextEta.textContent = nextFlight ? formatETA(nextFlight.eta) : '-';

    // Apply filter and sort
    const filtered = applyFilter(widebodies);
    const sorted = [...filtered].sort((a, b) => {
        // For landed flights, sort by landing time (most recent first)
        if (currentFilter === 'landed') {
            const getMinutes = (status) => {
                const match = status?.match(/landed\s+(\d{1,2}):(\d{2})/i);
                if (!match) return 0;
                let hours = parseInt(match[1]);
                const mins = parseInt(match[2]);
                // Convert to minutes since midnight, handling day boundary
                return hours * 60 + mins;
            };
            const aTime = getMinutes(a.status);
            const bTime = getMinutes(b.status);
            // Most recent first (descending), but handle day wraparound
            // If times are far apart (>12 hours diff), earlier time is actually from today
            const diff = bTime - aTime;
            if (Math.abs(diff) > 720) { // 12 hours in minutes
                return -diff; // Flip the sort
            }
            return diff;
        }
        // For other filters, sort by ETA (soonest first)
        return (a.eta || Infinity) - (b.eta || Infinity);
    });

    if (sorted.length === 0) {
        const typeLabel = showAllAircraft ? 'aircraft' : 'widebody arrivals';
        let msg = `No ${typeLabel}`;
        if (currentFilter === 'upcoming') msg = `No upcoming ${typeLabel}`;
        if (currentFilter === 'landed') msg = `No recently landed ${showAllAircraft ? 'aircraft' : 'widebodies'}`;
        container.innerHTML = `
            <div class="no-flights">
                <p>${msg}</p>
            </div>
        `;
    } else {
        container.innerHTML = sorted.map(renderFlightCard).join('');
    }

    // Update map if in map view
    if (currentView === 'map' && map) {
        updateMapMarkers();
    }
}

// Check if any widebody is on approach (under 30,000 ft)
function hasApproachingAircraft() {
    const widebodies = filterAircraft(allArrivals);
    return widebodies.some(a => a.live && a.altitude && a.altitude < APPROACH_ALTITUDE);
}

// Get current refresh interval
function getRefreshInterval() {
    return approachMode ? APPROACH_INTERVAL : NORMAL_INTERVAL;
}

// Update countdown every second
function tick() {
    const countdown = document.getElementById('countdown');
    const elapsed = Math.floor((Date.now() - lastRefreshTime) / 1000);
    const interval = getRefreshInterval();
    const remaining = Math.max(0, interval - elapsed);
    countdown.textContent = approachMode ? `${remaining} (LIVE)` : remaining;

    // Update all ETA countdowns
    document.querySelectorAll('.eta-countdown').forEach(el => {
        const eta = parseInt(el.dataset.eta);
        if (eta) {
            el.textContent = formatETA(eta);
        }
    });
}

// Show loading state
function setLoading(loading) {
    isLoading = loading;
}

// Update status indicator
function setStatus(isLive) {
    const indicator = document.getElementById('status-indicator');
    if (indicator) {
        indicator.textContent = isLive ? 'Live' : 'Offline';
        indicator.className = 'status-indicator ' + (isLive ? 'live' : 'offline');
    }
}

// Schedule next refresh based on approach mode
function scheduleNextRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);

    const wasApproachMode = approachMode;
    approachMode = hasApproachingAircraft();

    if (approachMode !== wasApproachMode) {
        console.log(approachMode ? 'Approach mode: ON (aircraft < 30,000 ft)' : 'Approach mode: OFF');
    }

    const interval = getRefreshInterval();
    refreshTimer = setTimeout(refresh, interval * 1000);
}

// Main refresh
async function refresh() {
    if (isLoading) return; // Skip if already loading

    setLoading(true);
    try {
        allArrivals = await fetchSchedule();
        updateDisplay();
        lastRefreshTime = Date.now();
        setStatus(true);
    } catch (error) {
        console.error('Error:', error);
        setStatus(false);
        document.getElementById('flights-container').innerHTML = `
            <div class="no-flights">
                <p>Error loading schedule: ${error.message}</p>
                <p style="margin-top: 10px;">Retrying...</p>
            </div>
        `;
    } finally {
        setLoading(false);
        scheduleNextRefresh();
    }
}

// Filter button handlers
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        currentFilter = btn.dataset.filter;
        savePreferences();
        updateDisplay();
    });
});

// Update page title based on current state
function updateTitle() {
    document.getElementById('page-title').innerHTML = `<span class="airport-code">${currentAirport}</span> Arrivals`;
    document.title = `AvGeek · ${currentAirport}`;
    document.getElementById('stat-label-total').textContent = showAllAircraft ? 'Aircraft Today' : 'Widebodies Today';
}

// Airport selector handlers
function selectAirport(airport) {
    currentAirport = airport.toUpperCase();
    updateTitle();
    savePreferences();

    // Update map center if in map view
    if (map) {
        const coords = AIRPORT_COORDS[currentAirport] || [37.6213, -122.3790];
        map.setView(coords, 6);
        updateAirportMarker();
    }

    refresh();
    fetchWeather();
}

document.querySelectorAll('.airport-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.airport-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('custom-airport').classList.remove('active');
        document.getElementById('custom-airport').value = '';
        btn.classList.add('active');
        selectAirport(btn.dataset.airport);
    });
});

// Custom airport input handler
const customInput = document.getElementById('custom-airport');
customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && customInput.value.trim().length >= 3) {
        document.querySelectorAll('.airport-btn').forEach(b => b.classList.remove('active'));
        customInput.classList.add('active');
        selectAirport(customInput.value.trim());
        customInput.blur();
    }
});

customInput.addEventListener('focus', () => {
    customInput.select();
});

// Aircraft type toggle handlers
document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        showAllAircraft = btn.dataset.type === 'all';
        updateTitle();
        savePreferences();
        updateDisplay();
    });
});

// Flight details modal
async function openFlightModal(flightId, flightNumber) {
    const modal = document.getElementById('flight-modal');
    const modalTitle = document.getElementById('modal-flight-number');
    const modalBody = document.getElementById('modal-body');

    modalTitle.textContent = flightNumber || 'Flight Details';
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    modalBody.innerHTML = `
        <div class="modal-loading">
            <div class="spinner"></div>
            <p>Loading flight details...</p>
        </div>
    `;

    try {
        const response = await fetch(`/api/flight-details?id=${flightId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderFlightModal(data);
    } catch (error) {
        modalBody.innerHTML = `
            <div class="modal-loading">
                <p style="color: #ef4444;">Error loading details: ${error.message}</p>
            </div>
        `;
    }
}

function closeFlightModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('flight-modal');
    modal.classList.remove('active');
    document.body.style.overflow = '';

    // Clean up mini map to prevent memory leaks
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }
}

function formatDuration(departureTs, arrivalTs) {
    if (!departureTs || !arrivalTs) return '-';
    const diff = (arrivalTs - departureTs) * 1000;
    if (diff <= 0) return '-';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${mins}m`;
}

function formatSpeed(knots) {
    if (!knots) return '-';
    return `${Math.round(knots)} kts`;
}

function formatHeading(degrees) {
    if (degrees === null || degrees === undefined) return '-';
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(degrees / 45) % 8;
    return `${Math.round(degrees)}° ${directions[index]}`;
}

function formatVerticalSpeed(fpm) {
    if (!fpm) return '-';
    const sign = fpm > 0 ? '+' : '';
    return `${sign}${Math.round(fpm)} ft/min`;
}

function renderFlightModal(data) {
    const modalBody = document.getElementById('modal-body');

    const duration = formatDuration(data.departureTime, data.arrivalTime);
    const departureTime = data.departureTime ? formatTime(data.departureTime) : '-';
    const arrivalTime = data.arrivalTime ? formatTime(data.arrivalTime) : '-';
    const vspeedClass = data.verticalSpeed > 100 ? 'positive' : data.verticalSpeed < -100 ? 'negative' : '';

    modalBody.innerHTML = `
        <div class="modal-route">
            <div class="modal-route-airport">
                <div class="modal-route-code">${data.originCode || '?'}</div>
                <div class="modal-route-name">${data.origin || ''}</div>
            </div>
            <div class="modal-route-arrow">✈ →</div>
            <div class="modal-route-airport">
                <div class="modal-route-code">${data.destinationCode || '?'}</div>
                <div class="modal-route-name">${data.destination || ''}</div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Aircraft</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-label">Type</span>
                    <span class="modal-value">${data.model || data.modelCode || '-'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Registration</span>
                    <span class="modal-value highlight">${data.registration || '-'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Airline</span>
                    <span class="modal-value">${data.airline || '-'}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Callsign</span>
                    <span class="modal-value">${data.callsign || '-'}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Current Position</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-label">Altitude</span>
                    <span class="modal-value">${formatAltitude(data.altitude)}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Speed</span>
                    <span class="modal-value">${formatSpeed(data.speed)}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Heading</span>
                    <span class="modal-value">${formatHeading(data.heading)}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Vertical Speed</span>
                    <span class="modal-value ${vspeedClass}">${formatVerticalSpeed(data.verticalSpeed)}</span>
                </div>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">Schedule</div>
            <div class="modal-grid">
                <div class="modal-item">
                    <span class="modal-label">Departure</span>
                    <span class="modal-value">${departureTime}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Arrival (Est.)</span>
                    <span class="modal-value">${arrivalTime}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Duration</span>
                    <span class="modal-value">${duration}</span>
                </div>
                <div class="modal-item">
                    <span class="modal-label">Status</span>
                    <span class="modal-value">${data.status || '-'}</span>
                </div>
            </div>
        </div>

        ${data.trail && data.trail.length > 0 && typeof initMiniMap === 'function' ? '<div id="modal-mini-map" class="modal-mini-map"></div>' : ''}
    `;

    // Initialize mini map if map mode is enabled
    if (data.trail && data.trail.length > 0 && typeof initMiniMap === 'function') {
        initMiniMap(data);
    }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in input
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
        case 'Escape':
            closeFlightModal();
            break;
        case 'm':
        case 'M':
            // Toggle map/list view
            setMapView(currentView === 'map' ? 'list' : 'map');
            break;
        case 'r':
        case 'R':
            // Refresh data
            if (!isLoading) refresh();
            break;
        case 'f':
        case 'F':
            // Fit map to show all flights
            if (currentView === 'map') fitMapToFlights();
            break;
        case '1':
            // Switch to upcoming filter
            document.querySelector('.filter-btn[data-filter="upcoming"]')?.click();
            break;
        case '2':
            // Switch to landed filter
            document.querySelector('.filter-btn[data-filter="landed"]')?.click();
            break;
        case '3':
            // Switch to all filter
            document.querySelector('.filter-btn[data-filter="all"]')?.click();
            break;
    }
});

// Map functions
function initMap() {
    if (map) return; // Already initialized

    const coords = AIRPORT_COORDS[currentAirport] || [37.6213, -122.3790];
    map = L.map('map-container').setView(coords, 6);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    }).addTo(map);

    // Add airport marker
    updateAirportMarker();
}

function updateAirportMarker() {
    if (!map) return;

    if (airportMarker) {
        map.removeLayer(airportMarker);
    }

    const coords = AIRPORT_COORDS[currentAirport] || [37.6213, -122.3790];
    const airportIcon = L.divIcon({
        className: 'airport-marker',
        html: `<span style="font-size: 24px;">🛬</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });

    airportMarker = L.marker(coords, { icon: airportIcon })
        .bindPopup(`<div class="map-popup-title">${currentAirport}</div>`)
        .addTo(map);
}

function createPlaneIcon(heading, isWidebody) {
    // ✈ emoji points East (90°), so subtract 90 to align with heading (0° = North)
    const rotation = (heading || 0) - 90;
    const colorClass = isWidebody ? 'widebody' : 'narrowbody';
    return L.divIcon({
        className: `plane-marker ${colorClass}`,
        html: `<span style="display: inline-block; transform: rotate(${rotation}deg);">✈</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
}

function fitMapToFlights() {
    if (!map || mapMarkers.length === 0) return;

    const bounds = L.latLngBounds(mapMarkers.map(m => m.getLatLng()));

    // Include airport in bounds
    const airportCoords = AIRPORT_COORDS[currentAirport];
    if (airportCoords) {
        bounds.extend(airportCoords);
    }

    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 8 });
}

function updateMapMarkers() {
    if (!map) return;

    // Clear existing markers properly to free memory
    mapMarkers.forEach(m => {
        m.closePopup();
        m.unbindPopup();
        map.removeLayer(m);
    });
    mapMarkers = [];

    const aircraft = filterAircraft(allArrivals);
    const liveFlights = aircraft.filter(a => a.live && a.lat && a.lon);

    liveFlights.forEach(flight => {
        const isWidebody = WIDEBODY_TYPES.has(flight.type);
        const icon = createPlaneIcon(flight.heading, isWidebody);

        const marker = L.marker([flight.lat, flight.lon], { icon })
            .addTo(map);

        const popupContent = `
            <div class="map-popup-title">${flight.flight}</div>
            <div class="map-popup-detail">Aircraft: <span>${flight.typeName || flight.type}</span></div>
            <div class="map-popup-detail">From: <span>${flight.origin}</span></div>
            <div class="map-popup-detail">Altitude: <span>${formatAltitude(flight.altitude)}</span></div>
            <div class="map-popup-detail">ETA: <span>${formatETA(flight.eta)}</span></div>
            ${flight.flightId ? `<button class="map-popup-btn" onclick="openFlightModal('${flight.flightId}', '${flight.flight}')">View Details</button>` : ''}
        `;

        marker.bindPopup(popupContent);
        mapMarkers.push(marker);
    });
}

function setMapView(view) {
    currentView = view;
    savePreferences();
    const mapContainer = document.getElementById('map-container');
    const flightsContainer = document.getElementById('flights-container');

    document.querySelectorAll('.view-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
    });
    const activeViewBtn = document.querySelector(`.view-btn[data-view="${view}"]`);
    if (activeViewBtn) {
        activeViewBtn.classList.add('active');
        activeViewBtn.setAttribute('aria-pressed', 'true');
    }

    if (view === 'map') {
        mapContainer.classList.add('active');
        flightsContainer.classList.add('hidden');
        initMap();
        updateMapMarkers();
        // Center on airport with wider zoom
        const coords = AIRPORT_COORDS[currentAirport] || [37.6213, -122.3790];
        map.setView(coords, 6);
        setTimeout(() => map.invalidateSize(), 100);
    } else {
        mapContainer.classList.remove('active');
        flightsContainer.classList.remove('hidden');
    }
}

// Mini map for modal
function initMiniMap(data) {
    const miniMapEl = document.getElementById('modal-mini-map');
    if (!miniMapEl || !data.trail || data.trail.length === 0) return;

    // Clean up previous mini map instance
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }

    miniMap = L.map('modal-mini-map', {
        zoomControl: false,
        attributionControl: false
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19
    }).addTo(miniMap);

    // Draw flight trail - filter out invalid coordinates
    const trailCoords = data.trail
        .filter(p => p && Array.isArray(p) && p[0] != null && p[1] != null && !isNaN(p[0]) && !isNaN(p[1]))
        .map(p => [p[0], p[1]]);

    if (trailCoords.length > 1) {
        const polyline = L.polyline(trailCoords, {
            color: '#06b6d4',
            weight: 3,
            opacity: 0.8
        }).addTo(miniMap);

        // Add current position marker
        if (data.lat && data.lon) {
            const planeIcon = createPlaneIcon(data.heading, true);
            L.marker([data.lat, data.lon], { icon: planeIcon }).addTo(miniMap);
        }

        // Add destination marker
        const destCoords = AIRPORT_COORDS[data.destinationCode];
        if (destCoords) {
            L.marker(destCoords, {
                icon: L.divIcon({
                    className: 'airport-marker',
                    html: '<span style="font-size: 16px;">🛬</span>',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                })
            }).addTo(miniMap);
        }

        // Fit bounds with padding
        try {
            miniMap.fitBounds(polyline.getBounds(), { padding: [30, 30] });
        } catch (e) {
            // Fallback to current position if bounds fail
            if (data.lat && data.lon) {
                miniMap.setView([data.lat, data.lon], 7);
            }
        }
    } else if (data.lat && data.lon) {
        // No trail but have position - show plane location
        const planeIcon = createPlaneIcon(data.heading, true);
        L.marker([data.lat, data.lon], { icon: planeIcon }).addTo(miniMap);
        miniMap.setView([data.lat, data.lon], 7);
    }
}

// View toggle handlers
document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        setMapView(btn.dataset.view);
    });
});

// Weather functions
async function fetchWeather() {
    try {
        const response = await fetch(`/api/weather?airport=${currentAirport}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        updateWeatherDisplay(data);
    } catch (error) {
        console.error('Weather fetch error:', error);
        hideWeatherCard();
    }
}

function updateWeatherDisplay(data) {
    const card = document.getElementById('weather-card');
    if (!data || data.error) {
        hideWeatherCard();
        return;
    }

    card.classList.add('active');
    card.classList.remove('error');

    // Weather icon based on conditions
    const iconMap = {
        '01d': '☀️', '01n': '🌙',
        '02d': '⛅', '02n': '☁️',
        '03d': '☁️', '03n': '☁️',
        '04d': '☁️', '04n': '☁️',
        '09d': '🌧️', '09n': '🌧️',
        '10d': '🌦️', '10n': '🌧️',
        '11d': '⛈️', '11n': '⛈️',
        '13d': '🌨️', '13n': '🌨️',
        '50d': '🌫️', '50n': '🌫️',
    };

    document.getElementById('weather-icon').textContent = iconMap[data.icon] || '🌤️';
    document.getElementById('weather-description').textContent = data.description || '';

    // Temperature
    if (data.temp !== null) {
        document.getElementById('weather-temp').textContent = `${data.temp}°F`;
    } else {
        document.getElementById('weather-temp').textContent = '-';
    }

    // Visibility - critical for spotting
    const visEl = document.getElementById('weather-visibility');
    if (data.visibility_miles !== null) {
        visEl.textContent = `${data.visibility_miles} mi`;
        visEl.className = 'weather-value';
        if (data.visibility_miles >= 10) {
            visEl.classList.add('good');
        } else if (data.visibility_miles >= 5) {
            visEl.classList.add('moderate');
        } else {
            visEl.classList.add('poor');
        }
    } else {
        visEl.textContent = '-';
        visEl.className = 'weather-value';
    }

    // Cloud cover
    const cloudsEl = document.getElementById('weather-clouds');
    if (data.clouds !== null) {
        cloudsEl.textContent = `${data.clouds}%`;
        cloudsEl.className = 'weather-value';
        if (data.clouds <= 25) {
            cloudsEl.classList.add('good');
        } else if (data.clouds <= 50) {
            cloudsEl.classList.add('moderate');
        } else {
            cloudsEl.classList.add('poor');
        }
    } else {
        cloudsEl.textContent = '-';
        cloudsEl.className = 'weather-value';
    }

    // Wind
    if (data.wind_speed !== null) {
        const windDir = data.wind_direction || '';
        document.getElementById('weather-wind').textContent = `${data.wind_speed} mph ${windDir}`;
    } else {
        document.getElementById('weather-wind').textContent = '-';
    }
}

function hideWeatherCard() {
    const card = document.getElementById('weather-card');
    card.classList.remove('active');
}

// Initialize UI from saved preferences
function initFromPreferences() {
    // Restore airport selection
    const airportBtns = document.querySelectorAll('.airport-btn');
    airportBtns.forEach(b => b.classList.remove('active'));
    const matchingAirportBtn = document.querySelector(`.airport-btn[data-airport="${currentAirport}"]`);
    if (matchingAirportBtn) {
        matchingAirportBtn.classList.add('active');
    } else {
        // Custom airport
        const customInput = document.getElementById('custom-airport');
        customInput.value = currentAirport;
        customInput.classList.add('active');
    }

    // Restore filter selection
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.filter-btn[data-filter="${currentFilter}"]`)?.classList.add('active');

    // Restore aircraft type selection
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.type-btn[data-type="${showAllAircraft ? 'all' : 'widebody'}"]`)?.classList.add('active');

    // Restore view selection - delay map init until after first data load
    if (currentView === 'map') {
        // Temporarily set to list, will switch to map after first refresh
        currentView = 'list';
        setTimeout(() => setMapView('map'), 100);
    }

    // Update title
    updateTitle();
}

// Offline detection
window.addEventListener('online', () => {
    console.log('Network online - refreshing data');
    setStatus(true);
    refresh();
    fetchWeather();
});

window.addEventListener('offline', () => {
    console.log('Network offline');
    setStatus(false);
    const indicator = document.getElementById('status-indicator');
    if (indicator) {
        indicator.textContent = 'Offline';
        indicator.className = 'status-indicator offline';
    }
});

// Start
initFromPreferences();
refresh();
fetchWeather();
setInterval(tick, 1000);
// Refresh weather every 5 minutes
setInterval(fetchWeather, 5 * 60 * 1000);
