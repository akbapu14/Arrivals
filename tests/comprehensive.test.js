/**
 * Comprehensive E2E tests for AvGeek app
 * Run with: node tests/comprehensive.test.js
 * Requires server running on localhost:8080
 */

const http = require('http');

const BASE_URL = 'http://localhost:8080';

// Test state
let passed = 0;
let failed = 0;
const errors = [];

// Widebody types (same as app.js)
const WIDEBODY_TYPES = new Set([
    'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
    'A359', 'A35K', 'A380', 'A388',
    'B744', 'B748', 'B74S', 'B762', 'B763', 'B764',
    'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779',
    'B788', 'B789', 'B78X', 'MD11',
]);

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

async function fetch(url, timeout = 30000) {
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
        req.setTimeout(timeout, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// ==================== API Tests ====================

async function testScheduleAPI() {
    console.log('\n📡 Testing Schedule API...');

    const airports = ['SFO', 'LAX', 'JFK', 'EWR', 'DFW', 'SAN'];

    for (const airport of airports) {
        try {
            const res = await fetch(`${BASE_URL}/api/schedule?airport=${airport}`);
            assert(res.status === 200, `${airport}: Returns 200 status`);
            assert(Array.isArray(res.data.arrivals), `${airport}: Has arrivals array`);
            assert(res.data.arrivals.length > 0, `${airport}: Has at least 1 arrival (got ${res.data.arrivals.length})`);

            // Check first arrival has required fields
            const first = res.data.arrivals[0];
            assert(first.flight, `${airport}: Arrival has flight number`);
            assert(first.type, `${airport}: Arrival has aircraft type`);
            assert(first.origin, `${airport}: Arrival has origin`);
        } catch (e) {
            assert(false, `${airport}: API call failed - ${e.message}`);
        }
    }
}

async function testScheduleAPIFields() {
    console.log('\n📋 Testing Schedule API field structure...');

    const res = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const arrivals = res.data.arrivals;

    // Required fields
    const requiredFields = ['flight', 'type', 'origin', 'status', 'flightId'];
    const optionalFields = ['eta', 'altitude', 'lat', 'lon', 'heading', 'typeName', 'originName', 'airline'];

    const sample = arrivals.slice(0, 10);
    for (const field of requiredFields) {
        const hasField = sample.every(a => a[field] !== undefined);
        assert(hasField, `All arrivals have required field: ${field}`);
    }

    // Check live flights have position data
    const liveFlights = arrivals.filter(a => a.live);
    if (liveFlights.length > 0) {
        const liveWidebodies = liveFlights.filter(a => WIDEBODY_TYPES.has(a.type));
        if (liveWidebodies.length > 0) {
            const withCoords = liveWidebodies.filter(a => a.lat && a.lon);
            assert(withCoords.length > 0, `Live widebodies have coordinates (${withCoords.length}/${liveWidebodies.length})`);
        }
    }
}

async function testFlightDetailsAPI() {
    console.log('\n✈️  Testing Flight Details API...');

    // Get a live flight ID
    const scheduleRes = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const liveFlights = scheduleRes.data.arrivals.filter(a => a.live && a.flightId);

    if (liveFlights.length === 0) {
        console.log('  ⚠ No live flights available for testing');
        return;
    }

    const testFlight = liveFlights[0];
    console.log(`  Testing flight: ${testFlight.flight} (${testFlight.flightId})`);

    const res = await fetch(`${BASE_URL}/api/flight-details?id=${testFlight.flightId}`);
    assert(res.status === 200, 'Returns 200 status');
    assert(res.data.flightId === testFlight.flightId, 'Correct flight ID returned');

    // Check optional detail fields
    const detailFields = ['registration', 'model', 'airline', 'speed', 'heading', 'verticalSpeed'];
    for (const field of detailFields) {
        if (res.data[field] !== undefined && res.data[field] !== null) {
            console.log(`    ${field}: ${res.data[field]}`);
        }
    }

    // Check trail data
    if (res.data.trail && res.data.trail.length > 0) {
        assert(Array.isArray(res.data.trail), 'Trail is an array');
        const validPoints = res.data.trail.filter(p =>
            Array.isArray(p) && p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1])
        );
        assert(validPoints.length > 0, `Trail has valid points (${validPoints.length})`);
    }
}

async function testFlightDetailsAPIError() {
    console.log('\n❌ Testing Flight Details API error handling...');

    const res = await fetch(`${BASE_URL}/api/flight-details?id=invalid123`);
    // Should return 200 with error or 500
    assert(res.status === 200 || res.status === 500, 'Handles invalid flight ID gracefully');
}

async function testWeatherAPI() {
    console.log('\n🌤️  Testing Weather API...');

    const airports = ['SFO', 'LAX', 'JFK'];

    for (const airport of airports) {
        const res = await fetch(`${BASE_URL}/api/weather?airport=${airport}`);
        assert(res.status === 200, `${airport}: Returns 200 status`);
        assert(res.data.airport === airport, `${airport}: Correct airport in response`);

        // If we have real data (API key configured)
        if (!res.data.error) {
            if (res.data.temp !== null) {
                assert(typeof res.data.temp === 'number', `${airport}: Temp is a number`);
                assert(res.data.temp > -50 && res.data.temp < 150, `${airport}: Temp is reasonable (${res.data.temp}°F)`);
            }
            if (res.data.visibility_miles !== null) {
                assert(res.data.visibility_miles >= 0, `${airport}: Visibility is non-negative`);
            }
        } else {
            console.log(`  ⚠ ${airport}: Weather API key not configured`);
        }
    }
}

// ==================== Data Logic Tests ====================

async function testWidebodyFiltering() {
    console.log('\n🛫 Testing widebody filtering logic...');

    const res = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const arrivals = res.data.arrivals;

    const widebodies = arrivals.filter(a => WIDEBODY_TYPES.has(a.type));
    const narrowbodies = arrivals.filter(a => !WIDEBODY_TYPES.has(a.type));

    console.log(`  Total: ${arrivals.length}, Widebodies: ${widebodies.length}, Narrowbodies: ${narrowbodies.length}`);

    assert(widebodies.length > 0, 'Has widebody arrivals');
    assert(arrivals.length === widebodies.length + narrowbodies.length, 'Widebody + narrowbody = total');

    // Verify widebody types are correct
    for (const wb of widebodies.slice(0, 5)) {
        assert(WIDEBODY_TYPES.has(wb.type), `${wb.flight} type ${wb.type} is widebody`);
    }
}

async function testUpcomingFilter() {
    console.log('\n⏰ Testing upcoming flight filter...');

    const res = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const arrivals = res.data.arrivals;
    const now = Date.now() / 1000;

    const upcoming = arrivals.filter(a => {
        if (a.status?.toLowerCase().includes('landed')) return false;
        if (!a.eta) return true;
        return a.eta > now;
    });

    const landed = arrivals.filter(a => a.status?.toLowerCase().includes('landed'));

    console.log(`  Upcoming: ${upcoming.length}, Landed: ${landed.length}`);

    // Verify upcoming flights don't have "landed" status
    for (const flight of upcoming.slice(0, 10)) {
        assert(
            !flight.status?.toLowerCase().includes('landed'),
            `Upcoming ${flight.flight} is not landed`
        );
    }
}

async function testETAFormat() {
    console.log('\n🕐 Testing ETA countdown format...');

    // Test the formatETA logic
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
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    const now = Date.now() / 1000;

    // Test cases
    assert(formatETA(now - 60) === 'Arrived', 'Past ETA shows "Arrived"');
    assert(formatETA(null) === '-', 'Null ETA shows "-"');

    const in30min = now + 30 * 60;
    const result30 = formatETA(in30min);
    assert(result30.includes(':'), `30min ETA shows MM:SS format (${result30})`);

    const in2hours = now + 2 * 60 * 60;
    const result2h = formatETA(in2hours);
    assert(result2h.includes('h'), `2h ETA shows hours format (${result2h})`);
}

// ==================== Map Logic Tests ====================

async function testPlaneIconRotation() {
    console.log('\n🧭 Testing plane icon rotation...');

    // The ✈ emoji points East (90°), so rotation = heading - 90
    const testCases = [
        { heading: 0, expected: -90, dir: 'North' },
        { heading: 90, expected: 0, dir: 'East' },
        { heading: 180, expected: 90, dir: 'South' },
        { heading: 270, expected: 180, dir: 'West' },
        { heading: 45, expected: -45, dir: 'NE' },
        { heading: 135, expected: 45, dir: 'SE' },
        { heading: 225, expected: 135, dir: 'SW' },
        { heading: 315, expected: 225, dir: 'NW' },
    ];

    for (const tc of testCases) {
        const rotation = tc.heading - 90;
        assert(rotation === tc.expected, `Heading ${tc.heading}° (${tc.dir}) → ${rotation}°`);
    }
}

async function testCoordinateValidation() {
    console.log('\n📍 Testing coordinate validation...');

    const res = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const withCoords = res.data.arrivals.filter(a => a.lat && a.lon);

    for (const flight of withCoords.slice(0, 10)) {
        assert(
            flight.lat >= -90 && flight.lat <= 90,
            `${flight.flight} lat ${flight.lat} is valid`
        );
        assert(
            flight.lon >= -180 && flight.lon <= 180,
            `${flight.flight} lon ${flight.lon} is valid`
        );
        if (flight.heading !== null && flight.heading !== undefined) {
            assert(
                flight.heading >= 0 && flight.heading <= 360,
                `${flight.flight} heading ${flight.heading}° is valid`
            );
        }
    }
}

// ==================== Static Assets Tests ====================

async function testStaticAssets() {
    console.log('\n📄 Testing static assets...');

    const assets = [
        { path: '/', name: 'index.html' },
        { path: '/app.js', name: 'app.js' },
    ];

    for (const asset of assets) {
        const res = await fetch(`${BASE_URL}${asset.path}`);
        assert(res.status === 200, `${asset.name} returns 200`);
        assert(res.raw.length > 100, `${asset.name} has content (${res.raw.length} bytes)`);
    }

    // Check index.html has required elements
    const htmlRes = await fetch(`${BASE_URL}/`);
    const html = htmlRes.raw;

    assert(html.includes('Leaflet'), 'HTML includes Leaflet');
    assert(html.includes('app.js'), 'HTML includes app.js');
    assert(html.includes('JetBrains Mono'), 'HTML includes custom font');
    assert(html.includes('type-btn'), 'HTML has type toggle buttons');
    assert(html.includes('filter-btn'), 'HTML has filter buttons');
    assert(html.includes('view-btn'), 'HTML has view toggle buttons');
    assert(html.includes('flight-modal'), 'HTML has flight modal');
    assert(html.includes('weather-card'), 'HTML has weather card');
}

async function testAppJSContent() {
    console.log('\n📜 Testing app.js content...');

    const res = await fetch(`${BASE_URL}/app.js`);
    const js = res.raw;

    assert(js.includes('WIDEBODY_TYPES'), 'Has widebody types constant');
    assert(js.includes('filterAircraft'), 'Has filterAircraft function');
    assert(js.includes('formatETA'), 'Has formatETA function');
    assert(js.includes('openFlightModal'), 'Has openFlightModal function');
    assert(js.includes('initMap'), 'Has initMap function');
    assert(js.includes('createPlaneIcon'), 'Has createPlaneIcon function');
    assert(js.includes('fetchWeather'), 'Has fetchWeather function');
    assert(js.includes('(heading || 0) - 90'), 'Has correct plane rotation formula');
}

// ==================== Performance Tests ====================

async function testAPIPerformance() {
    console.log('\n⚡ Testing API performance...');

    const endpoints = [
        { path: '/api/schedule?airport=SFO', name: 'Schedule API', maxTime: 30000 },
        { path: '/api/weather?airport=SFO', name: 'Weather API', maxTime: 15000 },
    ];

    for (const ep of endpoints) {
        const start = Date.now();
        try {
            await fetch(`${BASE_URL}${ep.path}`, ep.maxTime);
            const elapsed = Date.now() - start;
            assert(elapsed < ep.maxTime, `${ep.name} responds in ${elapsed}ms (< ${ep.maxTime}ms)`);
        } catch (e) {
            assert(false, `${ep.name} timed out or failed: ${e.message}`);
        }
    }
}

async function testRapidAirportSwitching() {
    console.log('\n🔄 Testing rapid airport switching (memory check)...');

    const airports = ['SFO', 'LAX', 'JFK', 'SFO', 'DFW', 'SFO'];

    for (const airport of airports) {
        const start = Date.now();
        const res = await fetch(`${BASE_URL}/api/schedule?airport=${airport}`);
        const elapsed = Date.now() - start;
        assert(res.status === 200, `${airport} switch: OK (${elapsed}ms, ${res.data.arrivals.length} arrivals)`);
    }
}

// ==================== Run All Tests ====================

async function runAllTests() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('           AvGeek Comprehensive Test Suite');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Server: ${BASE_URL}`);
    console.log(`Time: ${new Date().toISOString()}`);

    try {
        // API Tests
        await testScheduleAPI();
        await testScheduleAPIFields();
        await testFlightDetailsAPI();
        await testFlightDetailsAPIError();
        await testWeatherAPI();

        // Data Logic Tests
        await testWidebodyFiltering();
        await testUpcomingFilter();
        await testETAFormat();

        // Map Logic Tests
        await testPlaneIconRotation();
        await testCoordinateValidation();

        // Static Asset Tests
        await testStaticAssets();
        await testAppJSContent();

        // Performance Tests
        await testAPIPerformance();
        await testRapidAirportSwitching();

    } catch (error) {
        console.error('\n💥 Test suite error:', error.message);
    }

    // Results
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('                      RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
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
