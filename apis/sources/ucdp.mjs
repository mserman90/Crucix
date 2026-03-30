// UCDP — Uppsala Conflict Data Program
// Georeferenced Event Dataset (GED) & Candidate Events
// API docs: https://ucdp.uu.se/apidocs/
// Since Feb 2026, requires access token via x-ucdp-access-token header.
// Request a token from the API maintainer: https://ucdp.uu.se/apidocs/
// Set UCDP_ACCESS_TOKEN in .env

import { daysAgo } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const API_BASE = 'https://ucdpapi.pcr.uu.se/api';

// Current versions
const GED_VERSION = '25.1';              // Latest annual GED
const CANDIDATE_VERSION = '26.0.2';      // Latest monthly candidate events

// Violence type labels
const VIOLENCE_TYPES = {
  1: 'State-based conflict',
  2: 'Non-state conflict',
  3: 'One-sided violence',
};

// Fetch a single page from UCDP API with token auth
async function ucdpFetch(resource, version, params = {}) {
  const token = process.env.UCDP_ACCESS_TOKEN;
  const headers = { 'User-Agent': 'Crucix/1.0' };
  if (token) {
    headers['x-ucdp-access-token'] = token;
  }

  const qs = new URLSearchParams({ pagesize: '100', page: '0', ...params });
  const url = `${API_BASE}/${resource}/${version}?${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${errText.slice(0, 300)}` };
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { error: 'UCDP request timed out (20s)' };
    const cause = e.cause ? ` → ${e.cause.message || e.cause.code || e.cause}` : '';
    return { error: `UCDP fetch error: ${e.message}${cause}` };
  }
}

// Fetch all pages for a query (up to maxPages)
async function ucdpFetchAll(resource, version, params = {}, maxPages = 5) {
  const allResults = [];
  let page = 0;

  while (page < maxPages) {
    const data = await ucdpFetch(resource, version, { ...params, page: String(page) });
    if (data.error) return data;

    const results = data.Result || [];
    allResults.push(...results);

    // Stop if we've reached the last page
    if (!data.NextPageUrl || page >= (data.TotalPages - 1)) break;
    page++;
  }

  return { Result: allResults, TotalCount: allResults.length };
}

// Query GED events with filters
export async function getGedEvents(opts = {}) {
  const {
    startDate,
    endDate,
    country,
    typeOfViolence,
    pagesize = 100,
    version = GED_VERSION,
  } = opts;

  const params = { pagesize: String(pagesize) };
  if (startDate) params.StartDate = startDate;
  if (endDate) params.EndDate = endDate;
  if (country) params.Country = String(country);
  if (typeOfViolence) params.TypeOfViolence = String(typeOfViolence);

  return ucdpFetchAll('gedevents', version, params);
}

// Query candidate events (near real-time, monthly release)
export async function getCandidateEvents(opts = {}) {
  const {
    startDate,
    endDate,
    country,
    pagesize = 100,
    version = CANDIDATE_VERSION,
  } = opts;

  const params = { pagesize: String(pagesize) };
  if (startDate) params.StartDate = startDate;
  if (endDate) params.EndDate = endDate;
  if (country) params.Country = String(country);

  return ucdpFetchAll('gedevents', version, params);
}

// Query armed conflicts (yearly dataset)
export async function getArmedConflicts(opts = {}) {
  const { year, country, version = '25.1' } = opts;
  const params = { pagesize: '100' };
  if (year) params.year = String(year);
  if (country) params.Country = String(country);
  return ucdpFetch('ucdpprioconflict', version, params);
}

// Summarize events by field
function groupBy(events, field) {
  const map = {};
  for (const e of events) {
    const key = e[field] || 'Unknown';
    if (!map[key]) map[key] = { count: 0, fatalities: 0 };
    map[key].count += 1;
    map[key].fatalities += (e.best || 0);
  }
  return map;
}

// Briefing — latest conflict events from UCDP Candidate dataset
export async function briefing() {
  if (!process.env.UCDP_ACCESS_TOKEN) {
    return {
      source: 'UCDP',
      timestamp: new Date().toISOString(),
      status: 'no_token',
      message: 'Set UCDP_ACCESS_TOKEN in .env. Request a token at https://ucdp.uu.se/apidocs/',
    };
  }

  // Get recent candidate events (last 90 days for meaningful data)
  const endDate = daysAgo(0);
  const startDate = daysAgo(90);

  const data = await getCandidateEvents({
    startDate,
    endDate,
    pagesize: 100,
  });

  if (data?.error) {
    return { source: 'UCDP', timestamp: new Date().toISOString(), error: data.error };
  }

  const events = data.Result || [];

  // Calculate fatalities
  const totalFatalities = events.reduce((sum, e) => sum + (e.best || 0), 0);

  // Group by dimensions
  const byCountry = groupBy(events, 'country');
  const byRegion = groupBy(events, 'region');
  const byViolenceType = {};
  for (const e of events) {
    const label = VIOLENCE_TYPES[e.type_of_violence] || `Type ${e.type_of_violence}`;
    if (!byViolenceType[label]) byViolenceType[label] = { count: 0, fatalities: 0 };
    byViolenceType[label].count += 1;
    byViolenceType[label].fatalities += (e.best || 0);
  }

  // Top countries by event count
  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {});

  // Deadliest events
  const deadliestEvents = events
    .filter(e => e.best > 0)
    .sort((a, b) => (b.best || 0) - (a.best || 0))
    .slice(0, 15)
    .map(e => ({
      id: e.id,
      date_start: e.date_start,
      date_end: e.date_end,
      conflict: e.conflict_name,
      dyad: e.dyad_name,
      side_a: e.side_a,
      side_b: e.side_b,
      country: e.country,
      region: e.region,
      location: e.where_coordinates,
      description: e.where_description,
      violenceType: VIOLENCE_TYPES[e.type_of_violence] || `Type ${e.type_of_violence}`,
      fatalities: e.best || 0,
      fatalities_high: e.high || 0,
      fatalities_low: e.low || 0,
      deaths_a: e.deaths_a || 0,
      deaths_b: e.deaths_b || 0,
      deaths_civilians: e.deaths_civilians || 0,
      lat: e.latitude || null,
      lon: e.longitude || null,
    }));

  // Active conflicts (unique conflict names)
  const activeConflicts = [...new Set(events.map(e => e.conflict_name))].sort();

  return {
    source: 'UCDP (Uppsala Conflict Data Program)',
    timestamp: new Date().toISOString(),
    dataset: `GED Candidate v${CANDIDATE_VERSION}`,
    period: { start: startDate, end: endDate },
    totalEvents: events.length,
    totalFatalities,
    activeConflicts: activeConflicts.length,
    activeConflictNames: activeConflicts.slice(0, 20),
    byViolenceType,
    byRegion,
    topCountries,
    deadliestEvents,
  };
}

if (process.argv[1]?.endsWith('ucdp.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
