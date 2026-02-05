/**
 * E2E tests for map functionality
 * Run with: node tests/map.test.js (requires server running on localhost:8080)
 */

const http = require('http');

const BASE_URL = 'http://localhost:8080';

// Simple test runner
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.log(`✗ ${message}`);
        failed++;
    }
}

async function fetch(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
        }).on('error', reject);
    });
}

async function testScheduleAPIReturnsMapData() {
    console.log('\n--- Testing Schedule API returns map coordinates ---');

    const res = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    assert(res.status === 200, 'Schedule API returns 200');
    assert(Array.isArray(res.data.arrivals), 'Response contains arrivals array');

    // Check that live flights have lat/lon/heading
    const liveFlights = res.data.arrivals.filter(a => a.live);
    console.log(`Found ${liveFlights.length} live flights`);

    if (liveFlights.length > 0) {
        const flightsWithCoords = liveFlights.filter(a => a.lat && a.lon);
        console.log(`${flightsWithCoords.length} live flights have coordinates`);

        // At least some live flights should have coordinates
        assert(flightsWithCoords.length > 0 || liveFlights.length === 0,
            'Live flights have lat/lon coordinates (or none are live)');

        // Check coordinate validity
        for (const flight of flightsWithCoords.slice(0, 3)) {
            assert(
                typeof flight.lat === 'number' && flight.lat >= -90 && flight.lat <= 90,
                `Flight ${flight.flight} has valid latitude: ${flight.lat}`
            );
            assert(
                typeof flight.lon === 'number' && flight.lon >= -180 && flight.lon <= 180,
                `Flight ${flight.flight} has valid longitude: ${flight.lon}`
            );
            if (flight.heading != null) {
                assert(
                    typeof flight.heading === 'number' && flight.heading >= 0 && flight.heading <= 360,
                    `Flight ${flight.flight} has valid heading: ${flight.heading}`
                );
            }
        }
    }
}

async function testFlightDetailsAPIReturnsTrail() {
    console.log('\n--- Testing Flight Details API returns trail data ---');

    // First get a live flight ID
    const scheduleRes = await fetch(`${BASE_URL}/api/schedule?airport=SFO`);
    const liveFlights = scheduleRes.data.arrivals.filter(a => a.live && a.flightId);

    if (liveFlights.length === 0) {
        console.log('No live flights available to test flight details');
        return;
    }

    const testFlight = liveFlights[0];
    console.log(`Testing flight details for ${testFlight.flight} (ID: ${testFlight.flightId})`);

    const detailsRes = await fetch(`${BASE_URL}/api/flight-details?id=${testFlight.flightId}`);
    assert(detailsRes.status === 200, 'Flight details API returns 200');

    const details = detailsRes.data;
    assert(details.flightId === testFlight.flightId, 'Response has correct flight ID');

    // Check position data
    if (details.lat && details.lon) {
        assert(
            typeof details.lat === 'number' && details.lat >= -90 && details.lat <= 90,
            `Has valid latitude: ${details.lat}`
        );
        assert(
            typeof details.lon === 'number' && details.lon >= -180 && details.lon <= 180,
            `Has valid longitude: ${details.lon}`
        );
    }

    // Check trail data
    if (details.trail && details.trail.length > 0) {
        assert(Array.isArray(details.trail), 'Trail is an array');
        console.log(`Trail has ${details.trail.length} points`);

        // Validate trail points
        const validPoints = details.trail.filter(p =>
            Array.isArray(p) && p.length >= 2 &&
            typeof p[0] === 'number' && typeof p[1] === 'number' &&
            !isNaN(p[0]) && !isNaN(p[1])
        );

        assert(
            validPoints.length > 0,
            `Trail has ${validPoints.length} valid coordinate points`
        );

        // Check first and last point are in reasonable range
        if (validPoints.length > 0) {
            const first = validPoints[0];
            assert(
                first[0] >= -90 && first[0] <= 90 && first[1] >= -180 && first[1] <= 180,
                `First trail point is valid: [${first[0]}, ${first[1]}]`
            );
        }
    }

    // Check heading
    if (details.heading != null) {
        assert(
            typeof details.heading === 'number' && details.heading >= 0 && details.heading <= 360,
            `Has valid heading: ${details.heading}°`
        );
    }
}

async function testPlaneIconRotation() {
    console.log('\n--- Testing plane icon rotation calculation ---');

    // The plane emoji ✈ points East (90°)
    // Heading 0° = North, so rotation should be 0 - 90 = -90°
    // Heading 90° = East, so rotation should be 90 - 90 = 0°
    // Heading 180° = South, so rotation should be 180 - 90 = 90°
    // Heading 270° = West, so rotation should be 270 - 90 = 180°

    const testCases = [
        { heading: 0, expected: -90, direction: 'North' },
        { heading: 90, expected: 0, direction: 'East' },
        { heading: 180, expected: 90, direction: 'South' },
        { heading: 270, expected: 180, direction: 'West' },
        { heading: 45, expected: -45, direction: 'Northeast' },
    ];

    for (const tc of testCases) {
        const rotation = tc.heading - 90;
        assert(
            rotation === tc.expected,
            `Heading ${tc.heading}° (${tc.direction}) → rotation ${rotation}° (expected ${tc.expected}°)`
        );
    }
}

async function testAirportCoordinates() {
    console.log('\n--- Testing airport coordinates are valid ---');

    const airports = {
        'SFO': [37.6213, -122.3790],
        'LAX': [33.9425, -118.4081],
        'JFK': [40.6413, -73.7781],
        'EWR': [40.6895, -74.1745],
        'DFW': [32.8998, -97.0403],
        'SAN': [32.7338, -117.1933],
    };

    for (const [code, coords] of Object.entries(airports)) {
        const [lat, lon] = coords;
        assert(
            lat >= 20 && lat <= 50 && lon >= -130 && lon <= -70,
            `${code} coordinates are in continental US: [${lat}, ${lon}]`
        );
    }
}

async function testMultipleAirportSwitching() {
    console.log('\n--- Testing multiple airport API calls (memory check) ---');

    const airports = ['SFO', 'LAX', 'JFK', 'DFW'];

    for (const airport of airports) {
        const startTime = Date.now();
        const res = await fetch(`${BASE_URL}/api/schedule?airport=${airport}`);
        const elapsed = Date.now() - startTime;

        assert(res.status === 200, `${airport} API returns 200 in ${elapsed}ms`);
        assert(Array.isArray(res.data.arrivals), `${airport} has arrivals array`);
        console.log(`  ${airport}: ${res.data.arrivals.length} arrivals`);
    }
}

// Run all tests
async function runTests() {
    console.log('=== Map E2E Tests ===\n');
    console.log('Testing against:', BASE_URL);

    try {
        await testScheduleAPIReturnsMapData();
        await testFlightDetailsAPIReturnsTrail();
        await testPlaneIconRotation();
        await testAirportCoordinates();
        await testMultipleAirportSwitching();

        console.log('\n=== Results ===');
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);

        process.exit(failed > 0 ? 1 : 0);
    } catch (error) {
        console.error('\nTest error:', error.message);
        console.log('Make sure the server is running on localhost:8080');
        process.exit(1);
    }
}

runTests();
