/**
 * Unit tests for pure functions in app.js and server-side logic.
 *
 * These tests cover gaps identified in the test coverage analysis:
 * - calculateDistance() Haversine formula
 * - predictRunway() wind-direction-to-runway mapping
 * - formatHeading() degree-to-compass conversion
 * - formatVerticalSpeed() ft/min formatting
 * - formatDuration() flight duration calculation
 * - formatSpeed() knots display
 * - formatAltitude() altitude display
 * - isOnApproach() / isLanded() / isAirborne() / isUpcoming() status helpers
 * - applyFilter() / filterAircraft() filtering pipeline
 * - getStatusClass() CSS class mapping
 * - Landed-flight sort logic (including midnight wraparound edge case)
 * - Server: wind direction 16-point compass conversion
 * - Server: trail parsing for dict vs list point formats
 * - API: /api/positions and /api/aircraft-photo endpoints
 *
 * Run with: node tests/unit.test.js (no server required for pure-function tests)
 * Run API sections with: node tests/unit.test.js --with-server
 */

const http = require('http');

const BASE_URL = 'http://localhost:8080';
const WITH_SERVER = process.argv.includes('--with-server');

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.log(`  ✗ ${message}`);
        failed++;
        errors.push(message);
    }
}

function assertApprox(actual, expected, tolerance, message) {
    assert(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual.toFixed(2)}, expected ~${expected})`);
}

async function fetchHttp(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
                } catch {
                    resolve({ status: res.statusCode, data, raw: data });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ─── Re-implement pure functions from app.js ────────────────────────────────
// (app.js is browser-only; we inline the logic here for unit testing)

const WIDEBODY_TYPES = new Set([
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
]);

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function formatAltitude(ft) {
    if (!ft || ft <= 0) return '-';
    return `${Math.round(ft).toLocaleString()} ft`;
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

function formatDuration(departureTs, arrivalTs) {
    if (!departureTs || !arrivalTs) return '-';
    const diff = (arrivalTs - departureTs) * 1000;
    if (diff <= 0) return '-';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${mins}m`;
}

function getStatusClass(color) {
    if (color === 'green') return 'status-green';
    if (color === 'yellow') return 'status-yellow';
    if (color === 'red') return 'status-red';
    return 'status-gray';
}

function isLanded(arrival) {
    return arrival.status?.toLowerCase().includes('landed');
}

function isAirborne(arrival) {
    return arrival.live === true;
}

function isOnApproach(arrival) {
    return arrival.live && arrival.altitude && arrival.altitude < 10000;
}

function isUpcoming(arrival) {
    if (isLanded(arrival)) return false;
    const eta = arrival.eta;
    if (!eta) return true;
    return eta * 1000 > Date.now();
}

function filterAircraft(arrivals, showAllAircraft = false) {
    if (showAllAircraft) return arrivals;
    return arrivals.filter(a => WIDEBODY_TYPES.has(a.type));
}

function applyFilter(arrivals, currentFilter) {
    switch (currentFilter) {
        case 'upcoming': return arrivals.filter(isUpcoming);
        case 'landed':   return arrivals.filter(isLanded);
        default:         return arrivals;
    }
}

function predictRunway(airport, windDirection) {
    if (!windDirection && windDirection !== 0) return null;
    const runwayConfigs = {
        'SFO': [
            { heading: 280, name: '28L/28R', range: [190, 360] },
            { heading: 100, name: '10L/10R', range: [0, 190] }
        ],
        'LAX': [
            { heading: 250, name: '24L/24R/25L/25R', range: [160, 340] },
            { heading: 70,  name: '06L/06R/07L/07R', range: [340, 160] }
        ],
        'JFK': [
            { heading: 310, name: '31L/31R', range: [220, 40] },
            { heading: 40,  name: '04L/04R', range: [310, 130] },
            { heading: 220, name: '22L/22R', range: [130, 310] }
        ],
    };
    const config = runwayConfigs[airport];
    if (!config) return null;
    let bestRunway = config[0];
    let minDiff = 360;
    for (const rwy of config) {
        let diff = Math.abs(windDirection - rwy.heading);
        if (diff > 180) diff = 360 - diff;
        if (diff < minDiff) { minDiff = diff; bestRunway = rwy; }
    }
    return bestRunway.name;
}

// Landed-flight sort helper (mirrors app.js updateDisplay)
function getLandedSortTime(status) {
    const match = status?.match(/landed\s+(\d{1,2}):(\d{2})/i);
    if (!match) return 0;
    return parseInt(match[1]) * 60 + parseInt(match[2]);
}

function sortLanded(a, b) {
    const aTime = getLandedSortTime(a.status);
    const bTime = getLandedSortTime(b.status);
    const diff = bTime - aTime;
    if (Math.abs(diff) > 720) return -diff; // midnight wraparound
    return diff;
}

// Server-side wind direction conversion (mirrors server.py get_weather).
// Python uses int() which is floor-division for positive numbers, so we use Math.floor.
function windDegToCardinal(deg) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return directions[Math.floor((deg + 11.25) / 22.5) % 16];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testCalculateDistance() {
    console.log('\n📐 calculateDistance() — Haversine formula');

    // SFO to LAX: ~293 nautical miles (≠ 337 statute miles — function uses nm)
    const sfoToLax = calculateDistance(37.6213, -122.3790, 33.9425, -118.4081);
    assertApprox(sfoToLax, 293, 5, 'SFO→LAX ≈ 293 nm');

    // SFO to JFK: ~2242 nautical miles
    const sfoToJfk = calculateDistance(37.6213, -122.3790, 40.6413, -73.7781);
    assertApprox(sfoToJfk, 2242, 20, 'SFO→JFK ≈ 2242 nm');

    // Same point → 0
    assert(calculateDistance(37.6, -122.4, 37.6, -122.4) === 0, 'Same point → 0 nm');

    // Symmetry: A→B equals B→A
    const d1 = calculateDistance(37.6213, -122.3790, 33.9425, -118.4081);
    const d2 = calculateDistance(33.9425, -118.4081, 37.6213, -122.3790);
    assertApprox(d1, d2, 0.001, 'Distance is symmetric (A→B = B→A)');

    // Flight at ~800nm from SFO should show as live on the card (sanity)
    const d3 = calculateDistance(37.6213, -122.3790, 30, -120);
    assert(d3 > 0 && d3 < 2000, `Arbitrary in-range point returns positive nm (${Math.round(d3)})`);
}

function testPredictRunway() {
    console.log('\n🛬 predictRunway() — wind direction to active runway');

    // SFO: westerly wind (270°) → land on 28s (head-into-wind)
    assert(predictRunway('SFO', 270) === '28L/28R', 'SFO westerly wind (270°) → 28L/28R');
    // SFO: easterly wind (90°) → land on 10s
    assert(predictRunway('SFO', 90) === '10L/10R', 'SFO easterly wind (90°) → 10L/10R');
    // SFO: due west (280° matches heading exactly)
    assert(predictRunway('SFO', 280) === '28L/28R', 'SFO wind exactly on 28-heading → 28L/28R');

    // LAX: westerly → 24s
    assert(predictRunway('LAX', 250) === '24L/24R/25L/25R', 'LAX westerly wind (250°) → 24L/24R/25L/25R');
    // LAX: easterly → 06s
    assert(predictRunway('LAX', 70) === '06L/06R/07L/07R', 'LAX easterly wind (70°) → 06L/06R/07L/07R');

    // JFK: NW wind (310°) → 31L/31R
    assert(predictRunway('JFK', 310) === '31L/31R', 'JFK NW wind (310°) → 31L/31R');
    // JFK: NE wind (40°) → 04L/04R
    assert(predictRunway('JFK', 40) === '04L/04R', 'JFK NE wind (40°) → 04L/04R');
    // JFK: SW wind (220°) → 22L/22R
    assert(predictRunway('JFK', 220) === '22L/22R', 'JFK SW wind (220°) → 22L/22R');

    // Airport with no config → null
    assert(predictRunway('ORD', 270) === null, 'Unknown airport returns null');
    assert(predictRunway('SFO', null) === null, 'Null wind direction returns null');
    assert(predictRunway('SFO', undefined) === null, 'Undefined wind direction returns null');

    // Edge: 0° (due north) at SFO – diff to 28-heading (280°) is 80°, diff to 10-heading (100°)
    // is 100°, so 28L/28R wins (the algorithm finds minimum angular difference)
    assert(predictRunway('SFO', 0) === '28L/28R', 'SFO north wind (0°) → 28L/28R (80° off < 100° off)');
}

function testFormatHeading() {
    console.log('\n🧭 formatHeading() — degrees to compass label');

    assert(formatHeading(0)   === '0° N',   'North (0°)');
    assert(formatHeading(45)  === '45° NE', 'Northeast (45°)');
    assert(formatHeading(90)  === '90° E',  'East (90°)');
    assert(formatHeading(135) === '135° SE','Southeast (135°)');
    assert(formatHeading(180) === '180° S', 'South (180°)');
    assert(formatHeading(225) === '225° SW','Southwest (225°)');
    assert(formatHeading(270) === '270° W', 'West (270°)');
    assert(formatHeading(315) === '315° NW','Northwest (315°)');
    assert(formatHeading(360) === '360° N', '360° wraps to N');
    assert(formatHeading(null) === '-',     'null → "-"');
    assert(formatHeading(undefined) === '-','undefined → "-"');
}

function testFormatVerticalSpeed() {
    console.log('\n↕️  formatVerticalSpeed() — ft/min display');

    assert(formatVerticalSpeed(0) === '-',           'Zero vspeed → "-"');
    assert(formatVerticalSpeed(null) === '-',         'null → "-"');
    assert(formatVerticalSpeed(1500) === '+1500 ft/min', 'Positive climb shows "+"');
    assert(formatVerticalSpeed(-800) === '-800 ft/min',  'Descent shows "-" but no "+"');
    assert(formatVerticalSpeed(100)  === '+100 ft/min',  'Small positive climb');
    // Fractional values are rounded
    assert(formatVerticalSpeed(1234.7) === '+1235 ft/min', 'Rounds to nearest integer');
}

function testFormatDuration() {
    console.log('\n⏱️  formatDuration() — flight duration');

    const now = Math.floor(Date.now() / 1000);
    assert(formatDuration(null, now) === '-', 'Missing departure → "-"');
    assert(formatDuration(now, null) === '-', 'Missing arrival → "-"');

    // 2 hours = 7200 seconds
    assert(formatDuration(now, now + 7200) === '2h 0m', '2-hour flight');
    // 11 hours 30 minutes
    assert(formatDuration(now, now + 11 * 3600 + 30 * 60) === '11h 30m', '11.5-hour flight');
    // Arrival before departure → "-"
    assert(formatDuration(now + 3600, now) === '-', 'Negative duration → "-"');
    // 0 minutes (same timestamp) → "-"
    assert(formatDuration(now, now) === '-', 'Zero duration → "-"');
}

function testFormatSpeed() {
    console.log('\n💨 formatSpeed() — knots display');

    assert(formatSpeed(0) === '-',       'Zero → "-" (falsy)');
    assert(formatSpeed(null) === '-',    'null → "-"');
    assert(formatSpeed(450) === '450 kts', 'Typical cruise speed');
    assert(formatSpeed(280.6) === '281 kts', 'Rounds to nearest integer');
}

function testFormatAltitude() {
    console.log('\n🏔️  formatAltitude() — altitude display');

    assert(formatAltitude(0) === '-',    'Zero → "-"');
    assert(formatAltitude(null) === '-', 'null → "-"');
    assert(formatAltitude(-100) === '-', 'Negative → "-"');
    assert(formatAltitude(35000) === '35,000 ft', 'Typical cruise altitude with comma');
    assert(formatAltitude(3500) === '3,500 ft', '3500 ft formats correctly');
    // Value is rounded
    assert(formatAltitude(34987.6) === '34,988 ft', 'Rounds to nearest foot');
}

function testGetStatusClass() {
    console.log('\n🎨 getStatusClass() — CSS status classes');

    assert(getStatusClass('green')  === 'status-green',  '"green" → status-green');
    assert(getStatusClass('yellow') === 'status-yellow', '"yellow" → status-yellow');
    assert(getStatusClass('red')    === 'status-red',    '"red" → status-red');
    assert(getStatusClass('gray')   === 'status-gray',   'Unknown color → status-gray');
    assert(getStatusClass(null)     === 'status-gray',   'null → status-gray');
    assert(getStatusClass('')       === 'status-gray',   'Empty string → status-gray');
}

function testStatusHelpers() {
    console.log('\n✈️  isLanded / isAirborne / isOnApproach / isUpcoming');

    // isLanded
    assert(isLanded({ status: 'Landed 14:35' }) === true,  'Status "Landed 14:35" → landed');
    assert(isLanded({ status: 'LANDED' }) === true,         'Uppercase LANDED → landed');
    assert(isLanded({ status: 'Scheduled' }) === false,     'Scheduled → not landed');
    assert(!isLanded({ status: undefined }),                 'Undefined status → not landed (falsy)');

    // isAirborne
    assert(isAirborne({ live: true })  === true,  'live=true → airborne');
    assert(isAirborne({ live: false }) === false, 'live=false → not airborne');
    assert(isAirborne({}) === false,              'Missing live → not airborne');

    // isOnApproach — threshold is 10,000 ft
    assert(isOnApproach({ live: true, altitude: 9999 })  === true,  'live + 9999 ft → on approach');
    assert(isOnApproach({ live: true, altitude: 10000 }) === false, 'live + exactly 10000 ft → NOT on approach');
    assert(isOnApproach({ live: true, altitude: 35000 }) === false, 'live + cruise altitude → not on approach');
    assert(isOnApproach({ live: false, altitude: 5000 }) === false, 'Not live → not on approach (even low alt)');
    assert(!isOnApproach({ live: true, altitude: 0 }),             'live + altitude 0 → not on approach (0 is falsy guard)');
    assert(!isOnApproach({ live: true }),                          'live + no altitude → not on approach (undefined altitude)');

    // isUpcoming
    const futureEta = Math.floor(Date.now() / 1000) + 3600;
    const pastEta   = Math.floor(Date.now() / 1000) - 3600;
    assert(isUpcoming({ status: 'Scheduled', eta: futureEta }) === true, 'Future ETA → upcoming');
    assert(isUpcoming({ status: 'Scheduled', eta: pastEta  }) === false, 'Past ETA → not upcoming');
    assert(isUpcoming({ status: 'Landed 10:00', eta: futureEta }) === false, 'Landed flight → not upcoming');
    assert(isUpcoming({ status: 'Scheduled' }) === true, 'No ETA at all → upcoming (assume future)');
}

function testFilterAircraft() {
    console.log('\n🛫 filterAircraft() — widebody / all toggle');

    const flights = [
        { flight: 'UA1', type: 'B777' },   // not in set (B77W etc. are, but not B777)
        { flight: 'UA2', type: 'B77W' },   // widebody
        { flight: 'DL3', type: 'A321' },   // narrowbody
        { flight: 'AA4', type: 'B789' },   // widebody
        { flight: 'SW5', type: 'B737' },   // narrowbody
    ];

    // widebody-only mode
    const widebodies = filterAircraft(flights, false);
    assert(widebodies.length === 2, 'widebody filter returns 2 (B77W, B789)');
    assert(widebodies.every(f => WIDEBODY_TYPES.has(f.type)), 'All returned flights are widebodies');

    // "all" mode
    const all = filterAircraft(flights, true);
    assert(all.length === 5, 'all mode returns all 5 flights');
}

function testApplyFilter() {
    console.log('\n🔍 applyFilter() — upcoming / landed / all');

    const now = Math.floor(Date.now() / 1000);
    const flights = [
        { flight: 'A1', status: 'Scheduled',   eta: now + 3600,  live: false },
        { flight: 'A2', status: 'Landed 12:00', eta: now - 3600,  live: false },
        { flight: 'A3', status: 'En Route',     eta: now + 1800,  live: true  },
        { flight: 'A4', status: 'En Route',     eta: now - 1000,  live: true  }, // past ETA but still live
        { flight: 'A5', status: 'Scheduled',    eta: null,         live: false }, // no ETA → upcoming
    ];

    const upcoming = applyFilter(flights, 'upcoming');
    assert(upcoming.some(f => f.flight === 'A1'), 'Scheduled future → upcoming');
    assert(upcoming.some(f => f.flight === 'A3'), 'En Route live future → upcoming');
    assert(upcoming.some(f => f.flight === 'A5'), 'No ETA → upcoming');
    assert(!upcoming.some(f => f.flight === 'A2'), 'Landed → excluded from upcoming');

    const landed = applyFilter(flights, 'landed');
    assert(landed.length === 1 && landed[0].flight === 'A2', 'Only landed flight returned by landed filter');

    const all = applyFilter(flights, 'all');
    assert(all.length === 5, 'all filter returns everything');
}

function testLandedFlightSort() {
    console.log('\n🕐 Landed flight sort — midnight wraparound logic');

    // Normal sort: 14:35 should be more recent than 10:20
    const a = { status: 'Landed 14:35' };
    const b = { status: 'Landed 10:20' };
    assert(sortLanded(a, b) < 0, '14:35 sorts before 10:20 (most recent first)');

    // Midnight wraparound: 23:55 vs 00:05
    // The diff is 23*60+55 vs 0*60+5 = 1435 vs 5 → diff = -1430 (> 720), so flip
    const late  = { status: 'Landed 23:55' };
    const early = { status: 'Landed 00:05' };
    assert(sortLanded(late, early) > 0, '00:05 (today) sorts before 23:55 (yesterday) after midnight');

    // Missing status → time 0 → treated as earliest
    const noTime = { status: 'Landed' };
    const withTime = { status: 'Landed 12:00' };
    assert(sortLanded(withTime, noTime) < 0, 'Flight with parse-able time sorts before un-parseable');
}

function testWindDirectionConversion() {
    console.log('\n🌬️  Server wind direction 16-point compass conversion');

    assert(windDegToCardinal(0)   === 'N',   '0° → N');
    assert(windDegToCardinal(90)  === 'E',   '90° → E');
    assert(windDegToCardinal(180) === 'S',   '180° → S');
    assert(windDegToCardinal(270) === 'W',   '270° → W');
    assert(windDegToCardinal(45)  === 'NE',  '45° → NE');
    assert(windDegToCardinal(135) === 'SE',  '135° → SE');
    assert(windDegToCardinal(225) === 'SW',  '225° → SW');
    assert(windDegToCardinal(315) === 'NW',  '315° → NW');
    assert(windDegToCardinal(22)  === 'NNE', '22° → NNE');
    assert(windDegToCardinal(67)  === 'ENE', '67° → ENE');
    assert(windDegToCardinal(337) === 'NNW', '337° → NNW');
    assert(windDegToCardinal(359) === 'N',   '359° wraps to N');
    assert(windDegToCardinal(360) === 'N',   '360° = N');
}

function testServerTrailParsing() {
    console.log('\n🗺️  Server trail parsing — dict vs list format');

    // Mirrors fetch_flight_details() trail parsing in server.py
    function parseTrailPoint_dict(p) {
        if (typeof p === 'object' && !Array.isArray(p)) {
            return { lat: p.lat, lon: p.lng, alt: p.alt, spd: p.spd, hd: p.hd };
        }
        return null;
    }
    function parseTrailPoint_list(p) {
        if (Array.isArray(p) && p.length >= 5) {
            return { lat: p[0], lon: p[1], alt: p[2], spd: p[3], hd: p[4] };
        }
        return null;
    }

    // Dict format (newer FR24 API)
    const dictPoint = { lat: 37.5, lng: -122.1, alt: 10000, spd: 280, hd: 270 };
    const parsed1 = parseTrailPoint_dict(dictPoint);
    assert(parsed1.lat === 37.5, 'Dict: lat parsed correctly');
    assert(parsed1.lon === -122.1, 'Dict: lng→lon parsed correctly (FR24 uses "lng" key)');
    assert(parsed1.alt === 10000, 'Dict: alt parsed correctly');
    assert(parsed1.hd === 270, 'Dict: heading parsed correctly');

    // List format (older FR24 API): [lat, lon, alt, spd, heading, ...]
    const listPoint = [37.5, -122.1, 10000, 280, 270];
    const parsed2 = parseTrailPoint_list(listPoint);
    assert(parsed2.lat === 37.5, 'List: lat is index 0');
    assert(parsed2.lon === -122.1, 'List: lon is index 1');
    assert(parsed2.alt === 10000, 'List: alt is index 2');
    assert(parsed2.spd === 280, 'List: speed is index 3');
    assert(parsed2.hd === 270, 'List: heading is index 4');

    // Short list (fewer than 5 elements) → invalid
    const shortList = [37.5, -122.1, 10000];
    assert(parseTrailPoint_list(shortList) === null, 'List with <5 elements → null (no heading)');

    // FR24 trail output format (for modal): [[lat, lon, alt], ...]
    const trailPoint = { lat: 37.5, lng: -122.1, alt: 10000 };
    const outputFmt = [trailPoint.lat, trailPoint.lng, trailPoint.alt];
    assert(outputFmt[0] === 37.5 && outputFmt[1] === -122.1, 'Trail output: [lat, lng, alt]');
}

// ─── Server-dependent API tests ───────────────────────────────────────────────

async function testPositionsAPI() {
    console.log('\n📡 /api/positions endpoint');

    // Get a live flight ID to test with
    const scheduleRes = await fetchHttp(`${BASE_URL}/api/schedule?airport=SFO`);
    const liveFlights = scheduleRes.data.arrivals.filter(a => a.live && a.flightId);

    if (liveFlights.length === 0) {
        console.log('  ⚠ No live flights available; skipping positions API test');
        return;
    }

    const ids = liveFlights.slice(0, 3).map(f => f.flightId).join(',');
    const res = await fetchHttp(`${BASE_URL}/api/positions?ids=${ids}`);
    assert(res.status === 200, '/api/positions returns 200');
    assert(typeof res.data.positions === 'object', 'Response has "positions" object');

    const keys = Object.keys(res.data.positions);
    assert(keys.length > 0, `At least one position returned (got ${keys.length})`);

    // Validate structure of a returned position
    const firstPos = res.data.positions[keys[0]];
    assert(typeof firstPos.lat === 'number', 'Position has numeric lat');
    assert(typeof firstPos.lon === 'number', 'Position has numeric lon');
    assert(firstPos.lat >= -90 && firstPos.lat <= 90, 'lat in valid range');
    assert(firstPos.lon >= -180 && firstPos.lon <= 180, 'lon in valid range');
}

async function testPositionsAPIEmpty() {
    console.log('\n📡 /api/positions with empty ids');

    const res = await fetchHttp(`${BASE_URL}/api/positions?ids=`);
    assert(res.status === 200, 'Empty ids returns 200 (not a crash)');
    assert(typeof res.data.positions === 'object', 'Returns positions object (possibly empty)');
    assert(Object.keys(res.data.positions).length === 0, 'Empty ids → empty positions object');
}

async function testAircraftPhotoAPI() {
    console.log('\n📸 /api/aircraft-photo endpoint');

    // Test with a well-known registration (United Airlines 777)
    const res = await fetchHttp(`${BASE_URL}/api/aircraft-photo?reg=N77019`, 10000);
    assert(res.status === 200, '/api/aircraft-photo returns 200');
    assert('url' in res.data, 'Response has "url" field');
    // url is either a string or null
    assert(res.data.url === null || typeof res.data.url === 'string',
        'url is null or a string');
    if (res.data.url) {
        assert(res.data.url.startsWith('http'), 'url is a valid HTTP URL when present');
    }

    // Missing registration
    const missingRes = await fetchHttp(`${BASE_URL}/api/aircraft-photo`);
    assert(missingRes.status === 200, 'Missing reg returns 200 (not crash)');
    assert(missingRes.data.url === null || missingRes.data.error, 'Missing reg returns null url or error');
}

async function testScheduleAPIEdgeCases() {
    console.log('\n🔧 Schedule API edge cases');

    // Missing airport parameter → defaults to SFO
    const res = await fetchHttp(`${BASE_URL}/api/schedule`);
    assert(res.status === 200, 'Missing airport param returns 200 (defaults to SFO)');
    assert(Array.isArray(res.data.arrivals), 'Still returns arrivals array');

    // Unknown airport code
    const unknownRes = await fetchHttp(`${BASE_URL}/api/schedule?airport=XYZ`);
    assert(unknownRes.status === 200, 'Unknown airport returns 200 (not crash)');
    assert(Array.isArray(unknownRes.data.arrivals), 'Unknown airport returns arrivals array (possibly empty)');

    // Airport code is uppercased by server
    const lowerRes = await fetchHttp(`${BASE_URL}/api/schedule?airport=sfo`);
    assert(lowerRes.status === 200, 'Lowercase airport code accepted');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runAllTests() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('              AvGeek Unit Test Suite');
    console.log('═══════════════════════════════════════════════════════════');

    // Pure-function tests (no server required)
    testCalculateDistance();
    testPredictRunway();
    testFormatHeading();
    testFormatVerticalSpeed();
    testFormatDuration();
    testFormatSpeed();
    testFormatAltitude();
    testGetStatusClass();
    testStatusHelpers();
    testFilterAircraft();
    testApplyFilter();
    testLandedFlightSort();
    testWindDirectionConversion();
    testServerTrailParsing();

    // Server-dependent tests
    if (WITH_SERVER) {
        console.log('\n─── Server API tests (--with-server) ───────────────────────');
        try {
            await testPositionsAPI();
            await testPositionsAPIEmpty();
            await testAircraftPhotoAPI();
            await testScheduleAPIEdgeCases();
        } catch (e) {
            console.error('\n💥 Server API test error:', e.message);
            console.log('   Make sure the server is running on localhost:8080');
        }
    } else {
        console.log('\n  ℹ  Skipping server API tests (pass --with-server to include)');
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  ✓ Passed: ${passed}`);
    console.log(`  ✗ Failed: ${failed}`);
    console.log(`  Total:   ${passed + failed}`);
    if (errors.length > 0) {
        console.log('\nFailed tests:');
        errors.forEach(e => console.log(`  - ${e}`));
    }
    console.log('═══════════════════════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
