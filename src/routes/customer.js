'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const { validate, parseId } = require('../validate');
const queue = require('../services/queueService');
const catalog = require('../services/catalogService');
const { ok } = require('./respond');

module.exports = function customerRoutes(db) {
  const router = express.Router();

  // ---- public live information (any logged-in role)
  router.get('/centers', requireRole(), (_req, res) => ok(res, catalog.listCenters(db)));
  router.get('/centers/:id', requireRole(), (req, res) => ok(res, catalog.getCenter(db, parseId(req.params.id))));

  // ---- notifications (every role receives them)
  router.get('/notifications', requireRole(), (req, res) => ok(res, catalog.listNotifications(db, req.user.user_id)));
  router.post('/notifications/read-all', requireRole(), (req, res) => {
    catalog.markAllNotificationsRead(db, req.user.user_id);
    ok(res, null);
  });
  router.post('/notifications/:id/read', requireRole(), (req, res) => {
    catalog.markNotificationRead(db, req.user.user_id, parseId(req.params.id));
    ok(res, null);
  });

  // ---- tokens
  router.post('/tokens', requireRole('customer'), (req, res) => {
    const input = validate(req.body, {
      serviceTypeId: { type: 'int', required: true, min: 1, label: 'Service' },
      slotId: { type: 'int', min: 1, label: 'Time slot' },
      notes: { type: 'string', max: 200, label: 'Notes' },
    });
    const token = queue.joinQueue(db, req.user.user_id, {
      serviceTypeId: input.serviceTypeId,
      slotId: input.slotId ?? null,
      notes: input.notes ?? null,
    });
    ok(res, token, 201);
  });

  router.get('/tokens/active', requireRole('customer'), (req, res) => ok(res, queue.getActiveTokens(db, req.user.user_id)));
  router.get('/tokens/history', requireRole('customer'), (req, res) => ok(res, queue.getTokenHistory(db, req.user.user_id)));

  router.get('/tokens/:id/timeline', requireRole(), (req, res) => {
    ok(res, queue.getTokenTimeline(db, parseId(req.params.id), req.user));
  });

  router.post('/tokens/:id/cancel', requireRole('customer'), (req, res) => {
    ok(res, queue.cancelToken(db, req.user.user_id, parseId(req.params.id)));
  });

  router.post('/tokens/:id/feedback', requireRole('customer'), (req, res) => {
    const input = validate(req.body, {
      rating: { type: 'int', required: true, min: 1, max: 5, label: 'Rating' },
      comment: { type: 'string', max: 500, label: 'Comment' },
    });
    ok(res, queue.submitFeedback(db, req.user.user_id, parseId(req.params.id), input), 201);
  });

  return router;
};
