/**
 * Unit Tests for Team Name Normalizer
 * Tests team name normalization, abbreviation extraction, and title parsing
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTeamName,
  extractTeamAbbreviation,
  parseTeamsFromTitle,
  teamsMatch,
} from './team-normalizer';

describe('Team Name Normalizer', () => {
  describe('normalizeTeamName', () => {
    it('should normalize NBA team names', () => {
      expect(normalizeTeamName('Lakers')).toBe('los angeles lakers');
      expect(normalizeTeamName('LAL')).toBe('los angeles lakers');
      expect(normalizeTeamName('Los Angeles Lakers')).toBe('los angeles lakers');
      expect(normalizeTeamName('Celtics')).toBe('boston celtics');
      expect(normalizeTeamName('BOS')).toBe('boston celtics');
    });

    it('should normalize NFL team names', () => {
      expect(normalizeTeamName('Chiefs')).toBe('kansas city chiefs');
      expect(normalizeTeamName('KC')).toBe('kansas city chiefs');
      expect(normalizeTeamName('49ers')).toBe('san francisco 49ers');
      expect(normalizeTeamName('SF')).toBe('san francisco 49ers');
    });

    it('should normalize NHL team names', () => {
      expect(normalizeTeamName('Bruins')).toBe('boston bruins');
      expect(normalizeTeamName('Golden Knights')).toBe('vegas golden knights');
      expect(normalizeTeamName('VGK')).toBe('vegas golden knights');
    });

    it('should normalize EPL team names', () => {
      expect(normalizeTeamName('Man City')).toBe('manchester city');
      expect(normalizeTeamName('MCI')).toBe('manchester city');
      expect(normalizeTeamName('Man Utd')).toBe('manchester united');
      expect(normalizeTeamName('MUN')).toBe('manchester united');
      expect(normalizeTeamName('Arsenal')).toBe('arsenal');
    });

    it('should normalize La Liga team names', () => {
      expect(normalizeTeamName('Real Madrid')).toBe('real madrid');
      expect(normalizeTeamName('RMA')).toBe('real madrid');
      expect(normalizeTeamName('Barcelona')).toBe('fc barcelona');
      expect(normalizeTeamName('Barca')).toBe('fc barcelona');
    });

    it('should handle unknown teams by lowercasing', () => {
      expect(normalizeTeamName('Unknown Team')).toBe('unknown team');
      expect(normalizeTeamName('  Spaced  Team  ')).toBe('spaced team');
    });

    it('should handle empty/null input', () => {
      expect(normalizeTeamName('')).toBe('');
    });
  });

  describe('extractTeamAbbreviation', () => {
    it('should extract abbreviations from full names', () => {
      expect(extractTeamAbbreviation('Los Angeles Lakers')).toBe('LAL');
      expect(extractTeamAbbreviation('Boston Celtics')).toBe('BC');
      expect(extractTeamAbbreviation('New York Knicks')).toBe('NYK');
      expect(extractTeamAbbreviation('Golden State Warriors')).toBe('GSW');
    });

    it('should handle single-word names', () => {
      expect(extractTeamAbbreviation('Arsenal')).toBe('ARS');
      expect(extractTeamAbbreviation('Liverpool')).toBe('LIV');
    });

    it('should return short names as-is', () => {
      expect(extractTeamAbbreviation('LAL')).toBe('LAL');
      expect(extractTeamAbbreviation('BOS')).toBe('BOS');
    });

    it('should handle empty input', () => {
      expect(extractTeamAbbreviation('')).toBe('');
    });
  });

  describe('parseTeamsFromTitle', () => {
    it('should parse "vs" format', () => {
      const result = parseTeamsFromTitle('Lakers vs Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should parse "vs." format', () => {
      const result = parseTeamsFromTitle('Lakers vs. Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should parse "@" format', () => {
      const result = parseTeamsFromTitle('Lakers @ Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should parse "at" format', () => {
      const result = parseTeamsFromTitle('Lakers at Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should handle full team names', () => {
      const result = parseTeamsFromTitle('Los Angeles Lakers vs Boston Celtics');
      expect(result).toEqual({
        awayTeam: 'Los Angeles Lakers',
        homeTeam: 'Boston Celtics',
      });
    });

    it('should handle question format', () => {
      // Question formats without standard separators (vs, @, at) are not parseable
      const result = parseTeamsFromTitle('Will the Lakers beat the Celtics?');
      expect(result).toBeNull();
    });

    it('should return null for unparseable titles', () => {
      expect(parseTeamsFromTitle('')).toBeNull();
      expect(parseTeamsFromTitle('Some random title')).toBeNull();
    });
  });

  describe('teamsMatch', () => {
    it('should match exact normalized names', () => {
      expect(teamsMatch('Lakers', 'Los Angeles Lakers')).toBe(true);
      expect(teamsMatch('LAL', 'Lakers')).toBe(true);
    });

    it('should match partial names', () => {
      expect(teamsMatch('Lakers', 'lakers')).toBe(true);
      expect(teamsMatch('Manchester City', 'Man City')).toBe(true);
    });

    it('should match by abbreviation', () => {
      expect(teamsMatch('LAL', 'LAL')).toBe(true);
      expect(teamsMatch('BOS', 'BOS')).toBe(true);
    });

    it('should not match different teams', () => {
      expect(teamsMatch('Lakers', 'Celtics')).toBe(false);
      expect(teamsMatch('Manchester City', 'Manchester United')).toBe(false);
    });
  });
});

describe('Edge Cases', () => {
  it('should handle teams with special characters', () => {
    expect(normalizeTeamName("Brighton & Hove Albion")).toBe("brighton & hove albion");
    expect(normalizeTeamName("Philadelphia 76ers")).toBe("philadelphia 76ers");
  });

  it('should handle case insensitivity', () => {
    expect(normalizeTeamName('LAKERS')).toBe('los angeles lakers');
    expect(normalizeTeamName('lakers')).toBe('los angeles lakers');
    expect(normalizeTeamName('Lakers')).toBe('los angeles lakers');
  });

  it('should handle whitespace', () => {
    expect(normalizeTeamName('  Lakers  ')).toBe('los angeles lakers');
    expect(normalizeTeamName('Los  Angeles  Lakers')).toBe('los angeles lakers');
  });
});
