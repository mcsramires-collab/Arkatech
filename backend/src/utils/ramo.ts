import { RamoApolice } from '../types';

const RAMO_ALIASES: Record<string, RamoApolice> = {
  RCTRC: 'RCTRC',
  'RCTR-C': 'RCTRC',
  'RCTR C': 'RCTRC',
  RCDC: 'RCDC',
  'RC-DC': 'RCDC',
  'RCF-DC': 'RCDC',
  'RCF DC': 'RCDC',
  RCV: 'RCV',
  'RC-V': 'RCV',
  'RC V': 'RCV'
};

export function normalizeRamo(value: unknown): RamoApolice | undefined {
  const key = String(value ?? '').trim().toUpperCase();
  return RAMO_ALIASES[key];
}

export function isRamoApolice(value: unknown): value is RamoApolice {
  return normalizeRamo(value) !== undefined;
}
