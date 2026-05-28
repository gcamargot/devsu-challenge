import request from 'supertest'
import express from 'express'
import { healthRouter } from './health/health.js'
import sequelize from './shared/database/database.js'

// mount only the health router on a throwaway app so we don't open a real port
const app = express()
app.use(healthRouter)

afterAll(async () => {
    await sequelize.close()
})

describe('health endpoints', () => {
    test('GET /health returns 200 ok', async () => {
        const response = await request(app).get('/health')

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ status: 'ok' })
    })

    test('GET /ready returns 200 when the db answers', async () => {
        const response = await request(app).get('/ready')

        expect(response.status).toBe(200)
    })
})
