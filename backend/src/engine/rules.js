'use strict';

/**
 * NexusPay — Rule Evaluation DSL (Euclid-Lite)
 * 
 * Evaluates a set of JSON conditions against a nested context (Payment Intent).
 */

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  if (path.indexOf('.') === -1) return obj[path];
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

function evaluateCondition(conditions, context) {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  // 1. Support for logic gates: all_of (AND), any_of (OR), not
  if (conditions.all_of) {
    return Array.isArray(conditions.all_of) && conditions.all_of.every(c => evaluateCondition(c, context));
  }
  if (conditions.any_of) {
    return Array.isArray(conditions.any_of) && conditions.any_of.some(c => evaluateCondition(c, context));
  }
  if (conditions.not) {
    return !evaluateCondition(conditions.not, context);
  }

  // 2. Support for implicit AND if multiple keys provided
  for (const [key, expected] of Object.entries(conditions)) {
    // Skip logical keywords
    if (['all_of', 'any_of', 'not'].includes(key)) continue;

    const actual = getNestedValue(context, key);
    
    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      // Comparison operators
      if (expected.eq !== undefined && actual != expected.eq) return false;
      if (expected.neq !== undefined && actual == expected.neq) return false;
      if (expected.gt !== undefined && actual <= expected.gt) return false;
      if (expected.lt !== undefined && actual >= expected.lt) return false;
      if (expected.gte !== undefined && actual < expected.gte) return false;
      if (expected.lte !== undefined && actual > expected.lte) return false;
      if (expected.in !== undefined && Array.isArray(expected.in) && !expected.in.includes(actual)) return false;
      if (expected.not_in !== undefined && Array.isArray(expected.not_in) && expected.not_in.includes(actual)) return false;
      if (expected.matches !== undefined && typeof actual === 'string' && !new RegExp(expected.matches).test(actual)) return false;
      if (expected.exists !== undefined) {
        const exists = actual !== undefined && actual !== null;
        if (expected.exists !== exists) return false;
      }
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      // Basic equality (looser for type safety in JSON)
      if (actual != expected) return false;
    }
  }
  
  return true;
}

module.exports = {
  getNestedValue,
  evaluateCondition
};
