// Register service worker for caching
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
    });
}

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
let flightPaths = []; // Store flight path lines
let airportMarker = null;
let miniMap = null; // Track mini map instance for cleanup
let eventSource = null; // SSE connection
let isFirstLoad = true; // Track if this is initial load
let mapInitialized = false; // Track if map has been initialized
const NORMAL_INTERVAL = 60; // seconds
const APPROACH_INTERVAL = 1; // seconds when aircraft on approach
const APPROACH_ALTITUDE = 30000; // feet

// Airport coordinates for map centering
const AIRPORT_COORDS = {
    // US Major Hubs
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
    'IAH': [29.9902, -95.3368],
    'PHX': [33.4373, -112.0078],
    'LAS': [36.0840, -115.1537],
    'MCO': [28.4312, -81.3081],
    'IAD': [38.9531, -77.4565],
    'DCA': [38.8512, -77.0402],
    'MSP': [44.8848, -93.2223],
    'DTW': [42.2162, -83.3554],
    'PHL': [39.8729, -75.2437],
    'CLT': [35.2140, -80.9431],
    'SLC': [40.7884, -111.9778],
    'PDX': [45.5898, -122.5951],
    'OAK': [37.7126, -122.2197],
    'SJC': [37.3639, -121.9289],
    // International
    'LHR': [51.4700, -0.4543],
    'CDG': [49.0097, 2.5479],
    'FRA': [50.0379, 8.5622],
    'AMS': [52.3105, 4.7683],
    'HND': [35.5494, 139.7798],
    'NRT': [35.7720, 140.3929],
    'ICN': [37.4602, 126.4407],
    'PVG': [31.1443, 121.8083],
    'HKG': [22.3080, 113.9185],
    'SIN': [1.3644, 103.9915],
    'SYD': [-33.9399, 151.1753],
    'MEL': [-37.6690, 144.8410],
    'DXB': [25.2532, 55.3657],
    'DOH': [25.2609, 51.6138],
    'MEX': [19.4363, -99.0721],
    'GRU': [-23.4356, -46.4731],
    'YYZ': [43.6777, -79.6248],
    'YVR': [49.1967, -123.1815],
};

// Retry with exponential backoff
async function fetchWithRetry(url, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response;
        } catch (error) {
            lastError = error;
            if (i < maxRetries - 1) {
                // Exponential backoff: 1s, 2s, 4s
                const delay = Math.pow(2, i) * 1000;
                console.log(`Retry ${i + 1}/${maxRetries - 1} after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// Fetch schedule from server
async function fetchSchedule(fast = false) {
    const url = `/api/schedule?airport=${currentAirport}${fast ? '&fast=1' : ''}`;
    const response = await fetchWithRetry(url);
    const data = await response.json();
    if (data.cached) {
        console.log(`Using cached data (${data.cache_age}s old)`);
    }
    return data.arrivals || [];
}

// Connect to SSE stream for real-time updates
function connectSSE() {
    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource(`/api/stream?airport=${currentAirport}`);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.arrivals) {
                allArrivals = data.arrivals;
                updateDisplay();
                lastRefreshTime = Date.now();
                setStatus(true);
            }
        } catch (e) {
            console.warn('SSE parse error:', e);
        }
    };

    eventSource.onerror = () => {
        console.log('SSE connection lost, falling back to polling');
        eventSource.close();
        eventSource = null;
    };
}

// Disconnect SSE
function disconnectSSE() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
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

// Calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth's radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Format distance
function formatDistance(nm) {
    if (!nm || nm <= 0) return '-';
    if (nm < 100) return `${Math.round(nm)} nm`;
    return `${Math.round(nm).toLocaleString()} nm`;
}

// Estimate time to touchdown based on distance and altitude
function estimateTimeToTouchdown(distanceNm, altitudeFt) {
    if (!distanceNm || distanceNm <= 0) return null;

    // Average approach speed varies by distance from airport
    let avgSpeedKts;
    if (distanceNm < 20) {
        // Final approach - slower
        avgSpeedKts = 160;
    } else if (distanceNm < 100) {
        // Initial approach / pattern
        avgSpeedKts = 250;
    } else {
        // En route descent
        avgSpeedKts = 400;
    }

    const timeHours = distanceNm / avgSpeedKts;
    const timeMinutes = Math.round(timeHours * 60);

    if (timeMinutes < 1) return '< 1 min';
    if (timeMinutes === 1) return '1 min';
    return `${timeMinutes} min`;
}

// Check if flight is on approach (below 10,000 ft)
function isOnApproach(arrival) {
    return arrival.live && arrival.altitude && arrival.altitude < 10000;
}

// Copy text to clipboard and show feedback
async function copyToClipboard(text, event) {
    event?.stopPropagation();
    try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied: ${text}`);
    } catch (err) {
        console.error('Copy failed:', err);
    }
}

// Show toast notification
function showToast(message) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after delay
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// Render flight card
function renderFlightCard(arrival) {
    const landed = isLanded(arrival);
    const live = isAirborne(arrival);
    const clickable = live && arrival.flightId;
    const onApproach = isOnApproach(arrival);

    let cardClass = 'flight-card';
    if (live) cardClass += ' live';
    if (landed) cardClass += ' landed';
    if (clickable) cardClass += ' clickable';
    if (onApproach) cardClass += ' on-approach';

    const statusClass = getStatusClass(arrival.statusColor);
    const typeName = arrival.typeName || arrival.type;
    const clickHandler = clickable ? `onclick="openFlightModal('${arrival.flightId}', '${arrival.flight}')"` : '';

    // Calculate distance and ETA for live flights
    let distanceHtml = '';
    let ttdHtml = ''; // Time to touchdown
    if (live && arrival.lat && arrival.lon) {
        const destCoords = AIRPORT_COORDS[currentAirport];
        if (destCoords) {
            const distance = calculateDistance(arrival.lat, arrival.lon, destCoords[0], destCoords[1]);
            distanceHtml = `
                <div class="detail">
                    <span class="detail-label">Distance</span>
                    <span class="detail-value distance">${formatDistance(distance)}</span>
                </div>
            `;

            // Show time to touchdown for approaching flights (< 200 nm)
            if (distance < 200) {
                const ttd = estimateTimeToTouchdown(distance, arrival.altitude);
                if (ttd) {
                    ttdHtml = `
                        <div class="detail">
                            <span class="detail-label">Est. Touch</span>
                            <span class="detail-value ttd">${ttd}</span>
                        </div>
                    `;
                }
            }
        }
    }

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

    // Status badge
    let statusBadgeHtml = '';
    if (onApproach) {
        statusBadgeHtml = '<span class="status-badge approach-badge">APPROACH</span>';
    } else if (live) {
        statusBadgeHtml = '<span class="status-badge status-green">LIVE</span>';
    }

    // Format airline name (shorten if too long)
    const airlineName = arrival.airline || '';
    const shortAirline = airlineName.length > 25 ? airlineName.substring(0, 23) + '...' : airlineName;

    // Extract airline code from flight number for logo (e.g., "UA1234" -> "UA")
    const airlineCode = (arrival.flight || '').match(/^[A-Z]{2,3}/)?.[0] || '';
    const logoUrl = airlineCode ? `https://pics.avs.io/60/60/${airlineCode}.png` : '';

    return `
        <div class="${cardClass}" ${clickHandler}>
            <div class="flight-header">
                <div class="flight-route">
                    <span class="route-from">From</span>
                    <span class="origin-code">${arrival.origin}</span>
                    <span class="origin-name">${arrival.originName || ''}</span>
                </div>
                <div class="flight-meta">
                    <span class="aircraft-type">${typeName}</span>
                    ${statusBadgeHtml}
                </div>
            </div>
            <div class="flight-airline">
                ${logoUrl ? `<img src="${logoUrl}" alt="${airlineCode}" class="airline-logo" onerror="this.style.display='none'">` : ''}
                <div class="airline-info">
                    <span class="airline-name">${shortAirline || 'Unknown Airline'}</span>
                    <span class="flight-number copyable" onclick="copyToClipboard('${arrival.flight}', event)" title="Click to copy">${arrival.flight}</span>
                </div>
            </div>
            <div class="flight-details">
                <div class="detail">
                    <span class="detail-label">${etaLabel}</span>
                    <span class="detail-value eta">${etaValue}</span>
                </div>
                ${countdownHtml}
                ${altitudeHtml}
                ${distanceHtml}
                ${ttdHtml}
                ${!altitudeHtml && !landed && !distanceHtml && !ttdHtml ? `<div class="detail">
                    <span class="detail-label">Status</span>
                    <span class="detail-value"><span class="status-badge ${statusClass}">${arrival.status || 'Scheduled'}</span></span>
                </div>` : ''}
            </div>
        </div>
    `;
}

// Track current displayed flights for smart updates
let displayedFlightIds = [];

// Update cards in place without full re-render
function updateCardsInPlace(container, sorted) {
    const newFlightIds = sorted.map(a => a.flightId || a.flight);
    const existingCards = container.querySelectorAll('.flight-card');

    // If order or count changed significantly, do full re-render with fade
    const orderChanged = newFlightIds.join(',') !== displayedFlightIds.join(',');

    if (orderChanged || existingCards.length === 0) {
        // Fade out existing cards
        container.style.opacity = '0.7';

        setTimeout(() => {
            container.innerHTML = sorted.map(renderFlightCard).join('');
            displayedFlightIds = newFlightIds;

            // Fade back in
            setTimeout(() => {
                container.style.opacity = '1';
            }, 50);
        }, 150);
    } else {
        // Same flights, same order - update in place without flash
        existingCards.forEach((card, index) => {
            const arrival = sorted[index];
            if (!arrival) return;

            // Update dynamic values only
            const etaEl = card.querySelector('.eta-countdown');
            if (etaEl && arrival.eta) {
                etaEl.textContent = formatETA(arrival.eta);
                etaEl.dataset.eta = arrival.eta;
            }

            const altEl = card.querySelector('.altitude');
            if (altEl && arrival.altitude) {
                altEl.textContent = formatAltitude(arrival.altitude);
            }

            // Update distance if present
            const distEl = card.querySelector('.distance');
            if (distEl && arrival.lat && arrival.lon) {
                const destCoords = AIRPORT_COORDS[currentAirport];
                if (destCoords) {
                    const distance = calculateDistance(arrival.lat, arrival.lon, destCoords[0], destCoords[1]);
                    distEl.textContent = formatDistance(distance);
                }
            }
        });
        displayedFlightIds = newFlightIds;
    }
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
    const approachCountEl = document.getElementById('approach-count');
    const nextEta = document.getElementById('next-eta');
    const lastUpdate = document.getElementById('last-update');

    const widebodies = filterAircraft(allArrivals);
    const upcoming = widebodies.filter(isUpcoming);
    const airborne = widebodies.filter(isAirborne);
    const onApproachFlights = widebodies.filter(isOnApproach);

    // Update stats
    totalCount.textContent = widebodies.length;
    airborneCount.textContent = airborne.length;
    approachCountEl.textContent = onApproachFlights.length;

    // Add pulsing animation if there are flights on approach
    if (onApproachFlights.length > 0) {
        approachCountEl.classList.add('active');
    } else {
        approachCountEl.classList.remove('active');
    }

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
        // Sort by ETA (soonest first)
        // Approach status and live status are shown visually but don't affect sort order
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
        // Smart update: only re-render if data changed significantly
        updateCardsInPlace(container, sorted);
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

            // Add visual classes based on time remaining
            const diff = eta * 1000 - Date.now();
            const minutes = diff / 60000;

            el.classList.remove('soon', 'imminent');
            if (minutes <= 5 && minutes > 0) {
                el.classList.add('imminent');
            } else if (minutes <= 15 && minutes > 0) {
                el.classList.add('soon');
            }
        }
    });
}

// Show loading state
function setLoading(loading) {
    isLoading = loading;
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        if (loading) {
            refreshBtn.classList.add('spinning');
        } else {
            refreshBtn.classList.remove('spinning');
        }
    }
}

// Generate skeleton loading cards
function showSkeletonLoading() {
    const container = document.getElementById('flights-container');
    const skeletonCount = 6;
    let html = '<div class="skeleton-grid">';

    for (let i = 0; i < skeletonCount; i++) {
        html += `
            <div class="skeleton-card">
                <div class="skeleton-header">
                    <div class="skeleton-line skeleton-flight"></div>
                    <div class="skeleton-line skeleton-type"></div>
                </div>
                <div class="skeleton-details">
                    <div class="skeleton-detail">
                        <div class="skeleton-line skeleton-label"></div>
                        <div class="skeleton-line skeleton-value"></div>
                    </div>
                    <div class="skeleton-detail">
                        <div class="skeleton-line skeleton-label"></div>
                        <div class="skeleton-line skeleton-value"></div>
                    </div>
                    <div class="skeleton-detail">
                        <div class="skeleton-line skeleton-label"></div>
                        <div class="skeleton-line skeleton-value"></div>
                    </div>
                    <div class="skeleton-detail">
                        <div class="skeleton-line skeleton-label"></div>
                        <div class="skeleton-line skeleton-value"></div>
                    </div>
                </div>
            </div>
        `;
    }

    html += '</div>';
    container.innerHTML = html;
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

    // Show skeleton loading if this is a fresh load (no data yet)
    if (allArrivals.length === 0) {
        showSkeletonLoading();
    }

    try {
        // Use fast mode on first load to get cached data instantly
        const useFastMode = isFirstLoad;
        allArrivals = await fetchSchedule(useFastMode);
        updateDisplay();
        lastRefreshTime = Date.now();
        setStatus(true);

        // After first successful load, try to connect SSE for real-time updates
        if (isFirstLoad) {
            isFirstLoad = false;
            // Try SSE connection (will fall back to polling if it fails)
            setTimeout(() => connectSSE(), 1000);
        }
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
        // Only schedule polling refresh if SSE is not connected
        if (!eventSource) {
            scheduleNextRefresh();
        }
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

    // Disconnect SSE and reconnect for new airport
    disconnectSSE();

    // Update map center if in map view
    if (map) {
        const coords = AIRPORT_COORDS[currentAirport] || [37.6213, -122.3790];
        map.setView(coords, 6);
        updateAirportMarker();
    }

    // Clear arrivals and displayed IDs to trigger fresh render
    allArrivals = [];
    displayedFlightIds = [];
    refresh();
    fetchWeather();

    // Reconnect SSE after refresh
    setTimeout(() => connectSSE(), 2000);
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

// Help modal functions
function openHelpModal() {
    const modal = document.getElementById('help-modal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeHelpModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('help-modal');
    modal.classList.remove('active');
    document.body.style.overflow = '';
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in input
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
        case 'Escape':
            closeFlightModal();
            closeHelpModal();
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
        case '?':
            // Show help
            openHelpModal();
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
        className: 'airport-label',
        html: `<span>${currentAirport}</span>`,
        iconSize: [40, 20],
        iconAnchor: [20, 10]
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
        html: `<span style="display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; transform: rotate(${rotation}deg);">✈</span>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
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

    // Clear existing flight paths
    flightPaths.forEach(p => map.removeLayer(p));
    flightPaths = [];

    const aircraft = filterAircraft(allArrivals);
    const liveFlights = aircraft.filter(a => a.live && a.lat && a.lon);

    liveFlights.forEach(flight => {
        const isWidebody = WIDEBODY_TYPES.has(flight.type);
        const icon = createPlaneIcon(flight.heading, isWidebody);
        const onApproach = isOnApproach(flight);

        const marker = L.marker([flight.lat, flight.lon], { icon })
            .addTo(map);

        // Calculate distance for popup
        const destCoords = AIRPORT_COORDS[currentAirport];
        let distanceStr = '-';
        let ttdStr = '';
        if (destCoords) {
            const distance = calculateDistance(flight.lat, flight.lon, destCoords[0], destCoords[1]);
            distanceStr = formatDistance(distance);
            if (distance < 200) {
                const ttd = estimateTimeToTouchdown(distance, flight.altitude);
                if (ttd) {
                    ttdStr = `<div class="map-popup-detail">Est. Touch: <span class="popup-highlight">${ttd}</span></div>`;
                }
            }
        }

        const statusBadge = onApproach
            ? '<span class="map-popup-badge approach">ON APPROACH</span>'
            : '<span class="map-popup-badge live">LIVE</span>';

        const popupContent = `
            <div class="map-popup-header">
                <div class="map-popup-title">${flight.flight}</div>
                ${statusBadge}
            </div>
            <div class="map-popup-detail">Aircraft: <span>${flight.typeName || flight.type}</span></div>
            <div class="map-popup-detail">From: <span>${flight.origin}</span></div>
            <div class="map-popup-detail">Distance: <span>${distanceStr}</span></div>
            <div class="map-popup-detail">Altitude: <span>${formatAltitude(flight.altitude)}</span></div>
            ${ttdStr}
            <div class="map-popup-actions">
                ${flight.flightId ? `<button class="map-popup-btn" onclick="openFlightModal('${flight.flightId}', '${flight.flight}')">Details</button>` : ''}
                <button class="map-popup-btn secondary" onclick="centerOnFlight(${flight.lat}, ${flight.lon})">Center</button>
            </div>
        `;

        marker.bindPopup(popupContent);
        mapMarkers.push(marker);

        // Draw path line from origin to current position
        const originCoords = AIRPORT_COORDS[flight.origin];
        if (originCoords) {
            const pathLine = L.polyline(
                [originCoords, [flight.lat, flight.lon]],
                {
                    color: isWidebody ? '#06b6d4' : '#f59e0b',
                    weight: 1.5,
                    opacity: 0.3,
                    dashArray: '5, 10',
                    className: 'flight-path-line'
                }
            ).addTo(map);
            flightPaths.push(pathLine);
        }
    });
}

// Center map on a specific flight
function centerOnFlight(lat, lon) {
    if (map) {
        map.setView([lat, lon], 9, { animate: true });
    }
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

// Manual refresh button
document.getElementById('refresh-btn')?.addEventListener('click', () => {
    if (!isLoading) {
        const btn = document.getElementById('refresh-btn');
        btn.classList.add('spinning');
        refresh().finally(() => {
            btn.classList.remove('spinning');
        });
    }
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

// Predict likely runway based on wind direction (simplified)
function predictRunway(airport, windDirection) {
    if (!windDirection && windDirection !== 0) return null;

    // SFO runway configuration
    // Main runways: 28L/28R (280°) and 10L/10R (100°)
    // Typically use 28s for westerly winds, 10s for easterly
    const runwayConfigs = {
        'SFO': [
            { heading: 280, name: '28L/28R', range: [190, 360] },
            { heading: 100, name: '10L/10R', range: [0, 190] }
        ],
        'LAX': [
            { heading: 250, name: '24L/24R/25L/25R', range: [160, 340] },
            { heading: 70, name: '06L/06R/07L/07R', range: [340, 160] }
        ],
        'JFK': [
            { heading: 310, name: '31L/31R', range: [220, 40] },
            { heading: 40, name: '04L/04R', range: [310, 130] },
            { heading: 220, name: '22L/22R', range: [130, 310] }
        ],
    };

    const config = runwayConfigs[airport];
    if (!config) return null;

    // Find runway closest to wind direction (aircraft land into wind)
    let bestRunway = config[0];
    let minDiff = 360;

    for (const rwy of config) {
        // Calculate how well wind aligns with runway (want headwind)
        let diff = Math.abs(windDirection - rwy.heading);
        if (diff > 180) diff = 360 - diff;
        if (diff < minDiff) {
            minDiff = diff;
            bestRunway = rwy;
        }
    }

    return bestRunway.name;
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

    // Predicted runway (if we have wind direction in degrees)
    const runwayEl = document.getElementById('weather-runway');
    if (runwayEl && data.wind_deg !== undefined) {
        const predictedRunway = predictRunway(currentAirport, data.wind_deg);
        if (predictedRunway) {
            runwayEl.textContent = predictedRunway;
            runwayEl.parentElement.style.display = '';
        } else {
            runwayEl.parentElement.style.display = 'none';
        }
    } else if (runwayEl) {
        runwayEl.parentElement.style.display = 'none';
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

// Page visibility - pause updates when tab is hidden
let wasHidden = false;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        wasHidden = true;
        console.log('Tab hidden - pausing updates');
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    } else if (wasHidden) {
        wasHidden = false;
        console.log('Tab visible - resuming updates');
        // Refresh immediately if data is stale (> 1 minute old)
        const elapsed = Date.now() - lastRefreshTime;
        if (elapsed > 60000) {
            refresh();
        } else {
            scheduleNextRefresh();
        }
    }
});

// Start
initFromPreferences();
refresh();
fetchWeather();
setInterval(tick, 1000);
// Refresh weather every 5 minutes
setInterval(fetchWeather, 5 * 60 * 1000);
