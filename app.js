// Widebody aircraft type codes
const WIDEBODY_TYPES = new Set([
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
]);

// State
let allArrivals = [];
let currentFilter = 'upcoming';
let currentAirport = 'SFO';
let lastRefreshTime = Date.now();
const REFRESH_INTERVAL = 60; // seconds (schedule doesn't change fast)

// Fetch schedule from server
async function fetchSchedule() {
    const response = await fetch(`/api/schedule?airport=${currentAirport}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.arrivals || [];
}

// Filter for widebodies
function filterWidebodies(arrivals) {
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

    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
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

// Render flight card
function renderFlightCard(arrival) {
    const landed = isLanded(arrival);
    const live = isAirborne(arrival);

    let cardClass = 'flight-card';
    if (live) cardClass += ' live';
    if (landed) cardClass += ' landed';

    const statusClass = getStatusClass(arrival.statusColor);
    const typeName = arrival.typeName || arrival.type;

    return `
        <div class="${cardClass}">
            <div class="flight-header">
                <div>
                    <span class="flight-number">${arrival.flight}</span>
                    ${live ? '<span class="status-badge status-green">LIVE</span>' : ''}
                </div>
                <span class="aircraft-type">${typeName}</span>
            </div>
            <div class="flight-details">
                <div class="detail">
                    <span class="detail-label">ETA</span>
                    <span class="detail-value eta">${formatTime(arrival.eta)}</span>
                </div>
                <div class="detail">
                    <span class="detail-label">In</span>
                    <span class="detail-value eta-countdown" data-eta="${arrival.eta || ''}">${formatETA(arrival.eta)}</span>
                </div>
                <div class="detail">
                    <span class="detail-label">From</span>
                    <span class="detail-value origin">${arrival.origin}</span>
                </div>
                <div class="detail">
                    <span class="detail-label">Status</span>
                    <span class="detail-value"><span class="status-badge ${statusClass}">${arrival.status || 'Scheduled'}</span></span>
                </div>
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
        case 'airborne':
            return arrivals.filter(isAirborne);
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

    const widebodies = filterWidebodies(allArrivals);
    const upcoming = widebodies.filter(isUpcoming);
    const airborne = widebodies.filter(isAirborne);

    // Update stats
    totalCount.textContent = widebodies.length;
    airborneCount.textContent = airborne.length;
    lastUpdate.textContent = new Date().toLocaleTimeString();

    // Next arrival
    const nextFlight = upcoming.find(a => a.eta);
    nextEta.textContent = nextFlight ? formatETA(nextFlight.eta) : '-';

    // Apply filter and sort by ETA
    const filtered = applyFilter(widebodies);
    const sorted = [...filtered].sort((a, b) => (a.eta || Infinity) - (b.eta || Infinity));

    if (sorted.length === 0) {
        container.innerHTML = `
            <div class="no-flights">
                <p>No widebody arrivals ${currentFilter === 'all' ? '' : 'matching filter'}</p>
            </div>
        `;
    } else {
        container.innerHTML = sorted.map(renderFlightCard).join('');
    }
}

// Update countdown every second
function tick() {
    const countdown = document.getElementById('countdown');
    const elapsed = Math.floor((Date.now() - lastRefreshTime) / 1000);
    const remaining = Math.max(0, REFRESH_INTERVAL - elapsed);
    countdown.textContent = remaining;

    // Update all ETA countdowns
    document.querySelectorAll('.eta-countdown').forEach(el => {
        const eta = parseInt(el.dataset.eta);
        if (eta) {
            el.textContent = formatETA(eta);
        }
    });
}

// Main refresh
async function refresh() {
    try {
        allArrivals = await fetchSchedule();
        updateDisplay();
        lastRefreshTime = Date.now();
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('flights-container').innerHTML = `
            <div class="no-flights">
                <p>Error loading schedule: ${error.message}</p>
                <p style="margin-top: 10px;">Retrying...</p>
            </div>
        `;
    }
}

// Filter button handlers
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        updateDisplay();
    });
});

// Airport selector handlers
document.querySelectorAll('.airport-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.airport-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentAirport = btn.dataset.airport;
        document.getElementById('page-title').textContent = `${currentAirport} Widebody Arrivals`;
        refresh();
    });
});

// Start
refresh();
setInterval(refresh, REFRESH_INTERVAL * 1000);
setInterval(tick, 1000);
