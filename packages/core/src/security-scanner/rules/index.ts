import type { SecurityRule } from '../types';
import { agentHijackingRule } from './agent-hijacking';
import { dangerousExecutionRule } from './dangerous-execution';
import { dataExfiltrationRule } from './data-exfiltration';
import { promptInjectionRule } from './prompt-injection';
import { supplyChainRule } from './supply-chain';
import { unicodeAttacksRule } from './unicode-attacks';
import { urlThreatsRule } from './url-threats';
import { xssHtmlInjectionRule } from './xss-html-injection';

export {
  agentHijackingRule,
  dangerousExecutionRule,
  dataExfiltrationRule,
  promptInjectionRule,
  supplyChainRule,
  unicodeAttacksRule,
  urlThreatsRule,
  xssHtmlInjectionRule,
};

export const defaultSecurityRules: SecurityRule[] = [
  promptInjectionRule,
  agentHijackingRule,
  dangerousExecutionRule,
  unicodeAttacksRule,
  dataExfiltrationRule,
  xssHtmlInjectionRule,
  urlThreatsRule,
  supplyChainRule,
];
