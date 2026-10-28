'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const { validate, parseId } = require('../validate');
const admin = require('../services/adminService');
const analytics = require('../services/analyticsService');
const catalog = require('../services/catalogService');
const { setQueueStatus } = require('../services/queueService');
const { ok } = require('./respond');

const CATEGORIES = ['canteen', 'photocopy', 'clinic', 'office', 'library', 'other'];
const STATUSES = ['open', 'paused', 'closed'];

const centerRules = (required) => ({
  name: { type: 'string', required, min: 2, max: 80, label: 'Name' },
  category: { type: 'enum', values: CATEGORIES, required, label: 'Category' },
  location: { type: 'string', required, min: 2, max: 120, label: 'Location' },
  description: { type: 'string', max: 300, label: 'Description' },
  openingTime: { type: 'time', required, label: 'Opening time' },
  closingTime: { type: 'time', required, label: 'Closing time' },
  isActive: { type: 'bool', label: 'Active' },
});

const serviceRules = (required) => ({
  name: { type: 'string', required, min: 2, max: 80, label: 'Name' },
  code: { type: 'string', required, min: 1, max: 3, label: 'Token code' },
  description: { type: 'string', max: 300, label: 'Description' },
  avgServiceMinutes: { type: 'number', required, min: 0.5, max: 240, label: 'Average service minutes' },
  fee: { type: 'number', min: 0, max: 100000, label: 'Fee' },
  isActive: { type: 'bool', label: 'Active' },
});

function optionalInt(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return parseId(value, label);
}

module.exports = function adminRoutes(db) {
  const router = express.Router();
  router.use(requireRole('admin'));

  router.get('/overview', (_req, res) => ok(res, analytics.getOverview(db)));

  router.get('/analytics', (req, res) => {
    const { days } = validate(req.query, { days: { type: 'int', min: 1, max: 365, default: 30, label: 'Days' } });
    ok(res, analytics.getAnalytics(db, { centerId: optionalInt(req.query.centerId, 'center'), days }));
  });

  // ---- centers & configuration
  router.get('/centers', (_req, res) => ok(res, catalog.listCenters(db, { includeInactive: true })));
  router.post('/centers', (req, res) => ok(res, admin.createCenter(db, validate(req.body, centerRules(true))), 201));
  router.get('/centers/:id', (req, res) => ok(res, admin.getCenterConfig(db, parseId(req.params.id))));
  router.patch('/centers/:id', (req, res) => {
    ok(res, admin.updateCenter(db, parseId(req.params.id), validate(req.body, centerRules(false))));
  });

  router.post('/service-types', (req, res) => {
    const input = validate(req.body, {
      ...serviceRules(true),
      centerId: { type: 'int', required: true, min: 1, label: 'Center' },
    });
    ok(res, admin.createServiceType(db, { ...input, code: input.code.toUpperCase() }), 201);
  });
  router.patch('/service-types/:id', (req, res) => {
    const input = validate(req.body, serviceRules(false));
    if (input.code) input.code = input.code.toUpperCase();
    ok(res, admin.updateServiceType(db, parseId(req.params.id), input));
  });

  router.post('/counters', (req, res) => {
    const input = validate(req.body, {
      centerId: { type: 'int', required: true, min: 1, label: 'Center' },
      counterNumber: { type: 'int', required: true, min: 1, max: 99, label: 'Counter number' },
      label: { type: 'string', required: true, min: 2, max: 40, label: 'Label' },
      serviceTypeIds: { type: 'intArray', default: [], label: 'Services' },
    });
    ok(res, admin.createCounter(db, input), 201);
  });
  router.patch('/counters/:id', (req, res) => {
    const input = validate(req.body, {
      label: { type: 'string', min: 2, max: 40, label: 'Label' },
      status: { type: 'enum', values: STATUSES, label: 'Status' },
      serviceTypeIds: { type: 'intArray', label: 'Services' },
    });
    ok(res, admin.updateCounter(db, parseId(req.params.id), input));
  });

  router.post('/time-slots', (req, res) => {
    const input = validate(req.body, {
      centerId: { type: 'int', required: true, min: 1, label: 'Center' },
      startTime: { type: 'time', required: true, label: 'Start time' },
      endTime: { type: 'time', required: true, label: 'End time' },
      maxTokens: { type: 'int', required: true, min: 1, max: 500, label: 'Capacity' },
    });
    ok(res, admin.createTimeSlot(db, input), 201);
  });
  router.patch('/time-slots/:id', (req, res) => {
    const input = validate(req.body, { maxTokens: { type: 'int', required: true, min: 1, max: 500, label: 'Capacity' } });
    ok(res, admin.updateTimeSlot(db, parseId(req.params.id), input));
  });
  router.delete('/time-slots/:id', (req, res) => {
    admin.deleteTimeSlot(db, parseId(req.params.id));
    ok(res, null);
  });

  // ---- people
  router.get('/staff', (_req, res) => ok(res, admin.listStaff(db)));
  router.post('/staff', (req, res) => {
    const input = validate(req.body, {
      fullName: { type: 'string', required: true, min: 2, max: 100, label: 'Full name' },
      email: { type: 'email', required: true, label: 'Email' },
      phone: { type: 'phone', label: 'Phone' },
      password: { type: 'string', required: true, min: 8, max: 72, trim: false, label: 'Password' },
      centerId: { type: 'int', required: true, min: 1, label: 'Center' },
      counterId: { type: 'int', min: 1, label: 'Counter' },
      designation: { type: 'string', required: true, min: 2, max: 60, label: 'Designation' },
    });
    ok(res, admin.createStaff(db, input), 201);
  });
  router.patch('/staff/:id', (req, res) => {
    const input = validate(req.body, {
      centerId: { type: 'int', min: 1, label: 'Center' },
      designation: { type: 'string', min: 2, max: 60, label: 'Designation' },
    });
    // counterId may be explicitly null to unassign
    if ('counterId' in (req.body || {})) {
      input.counterId = req.body.counterId === null ? null : parseId(req.body.counterId, 'counter');
    }
    ok(res, admin.updateStaff(db, parseId(req.params.id), input));
  });

  router.get('/users', (req, res) => {
    const input = validate(req.query, {
      role: { type: 'enum', values: ['customer', 'staff', 'admin'], label: 'Role' },
      search: { type: 'string', max: 60, label: 'Search' },
    });
    ok(res, admin.listUsers(db, input));
  });
  router.patch('/users/:id', (req, res) => {
    const { isActive } = validate(req.body, { isActive: { type: 'bool', required: true, label: 'Active' } });
    admin.setUserActive(db, req.user.user_id, parseId(req.params.id), isActive);
    ok(res, null);
  });

  // ---- operations
  router.get('/queues', (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    ok(res, admin.listQueues(db, date));
  });
  router.patch('/queues/:id', (req, res) => {
    const { status } = validate(req.body, { status: { type: 'enum', values: STATUSES, required: true, label: 'Status' } });
    ok(res, setQueueStatus(db, req.user, parseId(req.params.id), status));
  });

  router.get('/feedback', (req, res) => {
    const { maxRating } = validate(req.query, { maxRating: { type: 'int', min: 1, max: 5, label: 'Rating' } });
    ok(res, admin.listFeedback(db, { centerId: optionalInt(req.query.centerId, 'center'), maxRating }));
  });

  // ---- database showcase
  router.get('/reports', (_req, res) => ok(res, admin.listReports()));
  router.get('/reports/:name', (req, res) => ok(res, admin.runReport(db, String(req.params.name))));
  router.get('/schema', (_req, res) => ok(res, admin.getSchemaInfo(db)));

  return router;
};
