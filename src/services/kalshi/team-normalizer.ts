/**
 * Team Name Normalizer
 * Normalizes team names for matching across platforms (Kalshi, Polymarket)
 * Handles:
 * - "Lakers" vs "Los Angeles Lakers" vs "LAL"
 * - "Man City" vs "Manchester City"
 * - Common abbreviations and aliases
 */

// Comprehensive team aliases mapping
// Keys are normalized (lowercase, trimmed), values are the canonical full name
const TEAM_ALIASES: Record<string, string> = {
  // NBA Teams
  'lakers': 'los angeles lakers',
  'lal': 'los angeles lakers',
  'la lakers': 'los angeles lakers',
  'celtics': 'boston celtics',
  'bos': 'boston celtics',
  'warriors': 'golden state warriors',
  'gsw': 'golden state warriors',
  'dubs': 'golden state warriors',
  'nets': 'brooklyn nets',
  'bkn': 'brooklyn nets',
  'knicks': 'new york knicks',
  'nyk': 'new york knicks',
  'sixers': 'philadelphia 76ers',
  '76ers': 'philadelphia 76ers',
  'phi': 'philadelphia 76ers',
  'heat': 'miami heat',
  'mia': 'miami heat',
  'bulls': 'chicago bulls',
  'chi': 'chicago bulls',
  'cavs': 'cleveland cavaliers',
  'cle': 'cleveland cavaliers',
  'cavaliers': 'cleveland cavaliers',
  'mavs': 'dallas mavericks',
  'dal': 'dallas mavericks',
  'mavericks': 'dallas mavericks',
  'rockets': 'houston rockets',
  'hou': 'houston rockets',
  'nuggets': 'denver nuggets',
  'den': 'denver nuggets',
  'suns': 'phoenix suns',
  'phx': 'phoenix suns',
  'spurs': 'san antonio spurs',
  'sas': 'san antonio spurs',
  'thunder': 'oklahoma city thunder',
  'okc': 'oklahoma city thunder',
  'jazz': 'utah jazz',
  'uta': 'utah jazz',
  'blazers': 'portland trail blazers',
  'por': 'portland trail blazers',
  'trail blazers': 'portland trail blazers',
  'clippers': 'los angeles clippers',
  'lac': 'los angeles clippers',
  'la clippers': 'los angeles clippers',
  'hawks': 'atlanta hawks',
  'atl': 'atlanta hawks',
  'hornets': 'charlotte hornets',
  'cha': 'charlotte hornets',
  'pistons': 'detroit pistons',
  'det': 'detroit pistons',
  'pacers': 'indiana pacers',
  'ind': 'indiana pacers',
  'bucks': 'milwaukee bucks',
  'mil': 'milwaukee bucks',
  'raptors': 'toronto raptors',
  'tor': 'toronto raptors',
  'wizards': 'washington wizards',
  'was': 'washington wizards',
  'magic': 'orlando magic',
  'orl': 'orlando magic',
  'grizzlies': 'memphis grizzlies',
  'mem': 'memphis grizzlies',
  'memphis': 'memphis grizzlies',
  'pelicans': 'new orleans pelicans',
  'nop': 'new orleans pelicans',
  'new orleans': 'new orleans pelicans',
  'timberwolves': 'minnesota timberwolves',
  'min': 'minnesota timberwolves',
  't-wolves': 'minnesota timberwolves',
  'minnesota': 'minnesota timberwolves',
  'kings': 'sacramento kings',
  'sac': 'sacramento kings',
  'sacramento': 'sacramento kings',
  'boston': 'boston celtics',
  'golden state': 'golden state warriors',
  'brooklyn': 'brooklyn nets',
  'new york': 'new york knicks',
  'philadelphia': 'philadelphia 76ers',
  'miami': 'miami heat',
  'chicago': 'chicago bulls',
  'cleveland': 'cleveland cavaliers',
  'dallas': 'dallas mavericks',
  'houston': 'houston rockets',
  'denver': 'denver nuggets',
  'phoenix': 'phoenix suns',
  'san antonio': 'san antonio spurs',
  'oklahoma city': 'oklahoma city thunder',
  'utah': 'utah jazz',
  'portland': 'portland trail blazers',
  'los angeles': 'los angeles lakers',
  'atlanta': 'atlanta hawks',
  'charlotte': 'charlotte hornets',
  'detroit': 'detroit pistons',
  'indiana': 'indiana pacers',
  'milwaukee': 'milwaukee bucks',
  'toronto': 'toronto raptors',
  'washington': 'washington wizards',
  'orlando': 'orlando magic',

  // NFL Teams (full phrase so "Buffalo Bills" normalizes correctly, not to buffalo sabres)
  'chiefs': 'kansas city chiefs',
  'kc': 'kansas city chiefs',
  'eagles': 'philadelphia eagles',
  'buffalo bills': 'buffalo bills',
  'bills': 'buffalo bills',
  'buf': 'buffalo bills',
  '49ers': 'san francisco 49ers',
  'sf': 'san francisco 49ers',
  'niners': 'san francisco 49ers',
  'cowboys': 'dallas cowboys',
  'packers': 'green bay packers',
  'gb': 'green bay packers',
  'ravens': 'baltimore ravens',
  'bal': 'baltimore ravens',
  'bengals': 'cincinnati bengals',
  'cin': 'cincinnati bengals',
  'dolphins': 'miami dolphins',
  'chargers': 'los angeles chargers',
  'lac chargers': 'los angeles chargers',
  'broncos': 'denver broncos',
  'raiders': 'las vegas raiders',
  'lvr': 'las vegas raiders',
  'steelers': 'pittsburgh steelers',
  'pit': 'pittsburgh steelers',
  'browns': 'cleveland browns',
  'colts': 'indianapolis colts',
  'texans': 'houston texans',
  'jaguars': 'jacksonville jaguars',
  'jax': 'jacksonville jaguars',
  'titans': 'tennessee titans',
  'ten': 'tennessee titans',
  'patriots': 'new england patriots',
  'ne': 'new england patriots',
  'pats': 'new england patriots',
  'jets': 'new york jets',
  'nyj': 'new york jets',
  'giants': 'new york giants',
  'nyg': 'new york giants',
  'commanders': 'washington commanders',
  'saints': 'new orleans saints',
  'no': 'new orleans saints',
  'falcons': 'atlanta falcons',
  'buccaneers': 'tampa bay buccaneers',
  'tb': 'tampa bay buccaneers',
  'bucs': 'tampa bay buccaneers',
  'panthers': 'carolina panthers',
  'car': 'carolina panthers',
  'bears': 'chicago bears',
  'lions': 'detroit lions',
  'vikings': 'minnesota vikings',
  'seahawks': 'seattle seahawks',
  'sea': 'seattle seahawks',
  'cardinals': 'arizona cardinals',
  'ari': 'arizona cardinals',
  'rams': 'los angeles rams',
  'lar': 'los angeles rams',

  // NHL Teams (full phrase so "Boston Bruins" doesn't match 'boston' -> boston celtics)
  'boston bruins': 'boston bruins',
  'bruins': 'boston bruins',
  'sabres': 'buffalo sabres',
  'buffalo': 'buffalo sabres',
  'red wings': 'detroit red wings',
  'panthers fl': 'florida panthers',
  'florida': 'florida panthers',
  'fla': 'florida panthers',
  'canadiens': 'montreal canadiens',
  'mtl': 'montreal canadiens',
  'habs': 'montreal canadiens',
  'montreal': 'montreal canadiens',
  'senators': 'ottawa senators',
  'ott': 'ottawa senators',
  'ottawa': 'ottawa senators',
  'lightning': 'tampa bay lightning',
  'tbl': 'tampa bay lightning',
  'tampa bay': 'tampa bay lightning',
  'maple leafs': 'toronto maple leafs',
  'leafs': 'toronto maple leafs',
  'capitals': 'washington capitals',
  'caps': 'washington capitals',
  'canes': 'carolina hurricanes',
  'hurricanes': 'carolina hurricanes',
  'carolina': 'carolina hurricanes',
  'blue jackets': 'columbus blue jackets',
  'cbj': 'columbus blue jackets',
  'columbus': 'columbus blue jackets',
  'devils': 'new jersey devils',
  'njd': 'new jersey devils',
  'new jersey': 'new jersey devils',
  'islanders': 'new york islanders',
  'nyi': 'new york islanders',
  'new york i': 'new york islanders',
  'rangers': 'new york rangers',
  'nyr': 'new york rangers',
  'flyers': 'philadelphia flyers',
  'penguins': 'pittsburgh penguins',
  'pens': 'pittsburgh penguins',
  'pittsburgh': 'pittsburgh penguins',
  'blackhawks': 'chicago blackhawks',
  'hawks chicago': 'chicago blackhawks',
  'avalanche': 'colorado avalanche',
  'avs': 'colorado avalanche',
  'col': 'colorado avalanche',
  'colorado': 'colorado avalanche',
  'stars': 'dallas stars',
  'wild': 'minnesota wild',
  'predators': 'nashville predators',
  'preds': 'nashville predators',
  'nsh': 'nashville predators',
  'nashville': 'nashville predators',
  'blues': 'st louis blues',
  'stl': 'st louis blues',
  'st louis': 'st louis blues',
  'st. louis': 'st louis blues',
  'jets winnipeg': 'winnipeg jets',
  'wpg': 'winnipeg jets',
  'winnipeg': 'winnipeg jets',
  'ducks': 'anaheim ducks',
  'ana': 'anaheim ducks',
  'anaheim': 'anaheim ducks',
  'flames': 'calgary flames',
  'cgy': 'calgary flames',
  'calgary': 'calgary flames',
  'oilers': 'edmonton oilers',
  'edm': 'edmonton oilers',
  'edmonton': 'edmonton oilers',
  'kraken': 'seattle kraken',
  'seattle': 'seattle kraken',
  'golden knights': 'vegas golden knights',
  'vgk': 'vegas golden knights',
  'knights': 'vegas golden knights',
  'vegas': 'vegas golden knights',
  'la kings': 'los angeles kings',
  'kings nhl': 'los angeles kings',
  'canucks': 'vancouver canucks',
  'van': 'vancouver canucks',
  'vancouver': 'vancouver canucks',
  'coyotes': 'arizona coyotes',
  'arizona': 'arizona coyotes',
  'utah hc': 'utah hockey club',
  'utah hockey': 'utah hockey club',
  'sharks': 'san jose sharks',
  'sjk': 'san jose sharks',
  'san jose': 'san jose sharks',

  // EPL Teams
  'man city': 'manchester city',
  'manchester c': 'manchester city',
  'mci': 'manchester city',
  'city': 'manchester city',
  'man utd': 'manchester united',
  'manchester u': 'manchester united',
  'mun': 'manchester united',
  'united': 'manchester united',
  'liverpool': 'liverpool',
  'liv': 'liverpool',
  'reds': 'liverpool',
  'arsenal': 'arsenal',
  'ars': 'arsenal',
  'gunners': 'arsenal',
  'chelsea': 'chelsea',
  'che': 'chelsea',
  'tottenham': 'tottenham hotspur',
  'spurs tottenham': 'tottenham hotspur',
  'tot': 'tottenham hotspur',
  'aston villa': 'aston villa',
  'avl': 'aston villa',
  'villa': 'aston villa',
  'newcastle': 'newcastle united',
  'newcastle utd': 'newcastle united',
  'brighton': 'brighton & hove albion',
  'bha': 'brighton & hove albion',
  'west ham': 'west ham united',
  'whu': 'west ham united',
  'hammers': 'west ham united',
  'brentford': 'brentford',
  'bre': 'brentford',
  'crystal palace': 'crystal palace',
  'cry': 'crystal palace',
  'palace': 'crystal palace',
  'fulham': 'fulham',
  'ful': 'fulham',
  'wolves': 'wolverhampton wanderers',
  'wolverhampton': 'wolverhampton wanderers',
  'wol': 'wolverhampton wanderers',
  'everton': 'everton',
  'eve': 'everton',
  'toffees': 'everton',
  'bournemouth': 'afc bournemouth',
  'bou': 'afc bournemouth',
  'nottingham': 'nottingham forest',
  'nfo': 'nottingham forest',
  'forest': 'nottingham forest',
  'luton': 'luton town',
  'lut': 'luton town',
  'burnley': 'burnley',
  'bur': 'burnley',
  'sheffield utd': 'sheffield united',
  'shu': 'sheffield united',
  'blades': 'sheffield united',

  // La Liga Teams
  'real madrid': 'real madrid',
  'rma': 'real madrid',
  'madrid': 'real madrid',
  'barcelona': 'fc barcelona',
  'barca': 'fc barcelona',
  'fcb': 'fc barcelona',
  'atletico': 'atletico madrid',
  'atletico madrid': 'atletico madrid',
  'atm': 'atletico madrid',
  'sevilla': 'sevilla fc',
  'sev': 'sevilla fc',
  'villarreal': 'villarreal cf',
  'vil': 'villarreal cf',
  'yellow submarine': 'villarreal cf',
  'real sociedad': 'real sociedad',
  'rso': 'real sociedad',
  'betis': 'real betis',
  'real betis': 'real betis',
  'rbb': 'real betis',
  'athletic bilbao': 'athletic bilbao',
  'athletic': 'athletic bilbao',
  'ath': 'athletic bilbao',
  'valencia': 'valencia cf',
  'val': 'valencia cf',
  'celta vigo': 'celta vigo',
  'celta': 'celta vigo',
  'cel': 'celta vigo',
  'getafe': 'getafe cf',
  'get': 'getafe cf',
  'osasuna': 'ca osasuna',
  'osa': 'ca osasuna',
  'rayo vallecano': 'rayo vallecano',
  'rayo': 'rayo vallecano',
  'mallorca': 'rcd mallorca',
  'mal': 'rcd mallorca',
  'las palmas': 'ud las palmas',
  'lpa': 'ud las palmas',
  'cadiz': 'cadiz cf',
  'cad': 'cadiz cf',
  'alaves': 'deportivo alaves',
  'ala': 'deportivo alaves',
  'granada': 'granada cf',
  'gra': 'granada cf',
  'almeria': 'ud almeria',
  'alm': 'ud almeria',
};

// Abbreviation patterns by league
const ABBREVIATION_PATTERNS: Record<string, RegExp> = {
  // Standard 3-letter abbreviations
  standard: /^[A-Z]{2,4}$/i,
  // City + Team pattern (e.g., "LA Lakers")
  cityTeam: /^[A-Z]{2,3}\s+\w+$/i,
};

/**
 * Normalize a team name for matching
 * Converts to lowercase, removes extra whitespace, handles common aliases
 * @param name - Team name to normalize
 * @returns Normalized team name
 */
export function normalizeTeamName(name: string): string {
  if (!name) return '';

  const lower = name.toLowerCase().trim();

  // Remove common suffixes that vary between sources
  const cleaned = lower
    .replace(/\s+(fc|cf|sc|afc|utd|united|city)$/i, match => {
      // Keep the suffix but normalize spacing
      return match.trim() ? ' ' + match.trim().toLowerCase() : '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  // Check if we have an alias mapping
  if (TEAM_ALIASES[cleaned]) {
    return TEAM_ALIASES[cleaned];
  }

  // Check each word as a potential alias
  const words = cleaned.split(' ');
  for (const word of words) {
    if (TEAM_ALIASES[word]) {
      return TEAM_ALIASES[word];
    }
  }

  return cleaned;
}

/**
 * Extract a team abbreviation from a team name
 * @param name - Full team name
 * @returns 2-4 character abbreviation
 */
export function extractTeamAbbreviation(name: string): string {
  if (!name) return '';

  const normalized = name.trim();

  // If already short, it might be an abbreviation
  if (normalized.length <= 4 && /^[A-Za-z]+$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  // For multi-word names, take first letter of each significant word
  const words = normalized.split(/\s+/).filter(w => {
    const lower = w.toLowerCase();
    // Skip articles and common suffixes
    return !['the', 'fc', 'cf', 'sc', 'afc', 'of'].includes(lower);
  });

  if (words.length === 0) return normalized.substring(0, 3).toUpperCase();

  if (words.length === 1) {
    // Single word - take first 3 characters
    return words[0].substring(0, 3).toUpperCase();
  }

  // Multiple words - take first letter of each (up to 4)
  const abbr = words
    .slice(0, 4)
    .map(w => w.charAt(0).toUpperCase())
    .join('');

  return abbr.length >= 2 ? abbr : words[0].substring(0, 3).toUpperCase();
}

/**
 * Parse team names from a Kalshi market title
 * Handles formats like:
 * - "Lakers vs Celtics"
 * - "Los Angeles Lakers vs Boston Celtics"
 * - "Will the Lakers beat the Celtics?"
 * - "Lakers @ Celtics"
 * @param title - Market title
 * @returns Object with home and away team names (or null if parsing fails)
 */
export function parseTeamsFromTitle(title: string): { homeTeam: string; awayTeam: string } | null {
  if (!title) return null;

  // Clean up the title
  let cleaned = title.trim();

  // Remove common question prefixes
  cleaned = cleaned
    .replace(/^will\s+(the\s+)?/i, '')
    .replace(/\?.*$/, '')
    .replace(/\s+win.*$/i, '')
    .replace(/\s+beat.*$/i, '');

  // Try different separators
  const separators = [
    /\s+vs\.?\s+/i,
    /\s+@\s+/,
    /\s+at\s+/i,
    /\s+-\s+/,
  ];

  for (const separator of separators) {
    const match = cleaned.split(separator);
    if (match.length === 2) {
      const team1 = match[0].trim();
      const team2 = match[1].trim();

      if (team1 && team2) {
        // Convention: first team is away, second is home (for "@" format)
        // For "vs" format: away vs home
        return {
          awayTeam: team1,
          homeTeam: team2,
        };
      }
    }
  }

  return null;
}

/**
 * Check if two team names match (using normalization)
 * @param name1 - First team name
 * @param name2 - Second team name
 * @returns True if teams match
 */
export function teamsMatch(name1: string, name2: string): boolean {
  const norm1 = normalizeTeamName(name1);
  const norm2 = normalizeTeamName(name2);

  // Exact match after normalization
  if (norm1 === norm2) return true;

  // Check if one contains the other (for partial matches)
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

  // Check abbreviation match
  const abbr1 = extractTeamAbbreviation(name1);
  const abbr2 = extractTeamAbbreviation(name2);
  if (abbr1 === abbr2 && abbr1.length >= 2) return true;

  return false;
}
