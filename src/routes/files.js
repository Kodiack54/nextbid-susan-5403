/**
 * Susan Files Routes - The Library
 * Susan's file organization system for project assets, screenshots, docs, etc.
 *
 * Susan's Dewey Decimal-ish System:
 * /{project_slug}/
 *   ├── bugs/          - Bug screenshots and evidence
 *   ├── docs/          - Documentation files, PDFs, exports
 *   ├── screenshots/   - UI captures, before/after shots
 *   ├── assets/        - Logos, images, design files
 *   ├── discoveries/   - Things Susan finds during analysis
 *   ├── exports/       - Data exports, reports, backups
 *   └── misc/          - Everything else
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Susan:Files');

const BUCKET_NAME = 'project-files';

// Susan's filing categories
const CATEGORIES = ['bugs', 'docs', 'screenshots', 'assets', 'discoveries', 'exports', 'misc'];

/**
 * POST /api/file - Upload a file to Susan's library
 * Body: { project_slug, category, filename, file (base64), content_type, metadata }
 */
router.post('/file', async (req, res) => {
  const {
    project_slug,
    category = 'misc',
    filename,
    file,          // base64 encoded file content
    content_type,
    metadata = {}  // Additional info Susan wants to track
  } = req.body;

  if (!project_slug || !filename || !file) {
    return res.status(400).json({ error: 'project_slug, filename, and file (base64) required' });
  }

  // Validate category
  const cat = CATEGORIES.includes(category) ? category : 'misc';

  // Build the file path: /{project_slug}/{category}/{filename}
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${project_slug}/${cat}/${timestamp}_${safeName}`;

  try {
    const client = getClient();

    // Decode base64 to buffer
    const fileBuffer = Buffer.from(file, 'base64');

    // Upload to Supabase Storage
    const { data, error } = await client.storage
      .from(BUCKET_NAME)
      .upload(filePath, fileBuffer, {
        contentType: content_type || 'application/octet-stream',
        upsert: false
      });

    if (error) throw error;

    // Get public URL
    const { data: urlData } = client.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    logger.info('File uploaded to library', {
      project: project_slug,
      category: cat,
      filename: safeName,
      path: filePath
    });

    res.json({
      success: true,
      file: {
        path: filePath,
        url: urlData.publicUrl,
        category: cat,
        filename: safeName,
        project_slug,
        uploaded_at: new Date().toISOString(),
        metadata
      }
    });
  } catch (err) {
    logger.error('File upload failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files - List files in Susan's library
 * Query: project_slug, category (optional)
 */
router.get('/files', async (req, res) => {
  const { project_slug, category } = req.query;

  if (!project_slug) {
    return res.status(400).json({ error: 'project_slug required' });
  }

  try {
    const client = getClient();

    // Build path to list
    let listPath = project_slug;
    if (category && CATEGORIES.includes(category)) {
      listPath = `${project_slug}/${category}`;
    }

    const { data, error } = await client.storage
      .from(BUCKET_NAME)
      .list(listPath, {
        limit: 100,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error) throw error;

    // If we listed the project root, we need to list each category
    let files = [];

    if (!category) {
      // List all categories for this project
      for (const cat of CATEGORIES) {
        const { data: catData } = await client.storage
          .from(BUCKET_NAME)
          .list(`${project_slug}/${cat}`, { limit: 50 });

        if (catData && catData.length > 0) {
          const filesWithUrls = catData
            .filter(f => f.name) // Filter out folder entries
            .map(f => {
              const filePath = `${project_slug}/${cat}/${f.name}`;
              const { data: urlData } = client.storage
                .from(BUCKET_NAME)
                .getPublicUrl(filePath);

              return {
                name: f.name,
                path: filePath,
                url: urlData.publicUrl,
                category: cat,
                size: f.metadata?.size,
                created_at: f.created_at,
                content_type: f.metadata?.mimetype
              };
            });
          files = files.concat(filesWithUrls);
        }
      }
    } else {
      // List specific category
      files = (data || [])
        .filter(f => f.name)
        .map(f => {
          const filePath = `${project_slug}/${category}/${f.name}`;
          const { data: urlData } = client.storage
            .from(BUCKET_NAME)
            .getPublicUrl(filePath);

          return {
            name: f.name,
            path: filePath,
            url: urlData.publicUrl,
            category,
            size: f.metadata?.size,
            created_at: f.created_at,
            content_type: f.metadata?.mimetype
          };
        });
    }

    // Sort by created_at descending
    files.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      success: true,
      files,
      project_slug,
      category: category || 'all',
      total: files.length
    });
  } catch (err) {
    logger.error('File list failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/file/:path - Get file info/URL
 */
router.get('/file/*', async (req, res) => {
  const filePath = req.params[0];

  if (!filePath) {
    return res.status(400).json({ error: 'File path required' });
  }

  try {
    const client = getClient();

    const { data: urlData } = client.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    res.json({
      success: true,
      path: filePath,
      url: urlData.publicUrl
    });
  } catch (err) {
    logger.error('File info failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/file - Delete a file from the library
 * Body: { path }
 */
router.delete('/file', async (req, res) => {
  const { path: filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'File path required' });
  }

  try {
    const client = getClient();

    const { error } = await client.storage
      .from(BUCKET_NAME)
      .remove([filePath]);

    if (error) throw error;

    logger.info('File deleted from library', { path: filePath });
    res.json({ success: true, deleted: filePath });
  } catch (err) {
    logger.error('File delete failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/organize - Susan reorganizes files (move between categories)
 */
router.post('/files/organize', async (req, res) => {
  const { from_path, to_category, project_slug } = req.body;

  if (!from_path || !to_category || !project_slug) {
    return res.status(400).json({ error: 'from_path, to_category, and project_slug required' });
  }

  if (!CATEGORIES.includes(to_category)) {
    return res.status(400).json({ error: `Invalid category. Use: ${CATEGORIES.join(', ')}` });
  }

  try {
    const client = getClient();

    // Extract filename from path
    const filename = from_path.split('/').pop();
    const newPath = `${project_slug}/${to_category}/${filename}`;

    // Move file (copy then delete)
    const { error: moveError } = await client.storage
      .from(BUCKET_NAME)
      .move(from_path, newPath);

    if (moveError) throw moveError;

    const { data: urlData } = client.storage
      .from(BUCKET_NAME)
      .getPublicUrl(newPath);

    logger.info('File reorganized', { from: from_path, to: newPath });

    res.json({
      success: true,
      old_path: from_path,
      new_path: newPath,
      url: urlData.publicUrl,
      category: to_category
    });
  } catch (err) {
    logger.error('File reorganize failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/categories - Get Susan's filing categories
 */
router.get('/files/categories', (req, res) => {
  res.json({
    success: true,
    categories: CATEGORIES.map(cat => ({
      id: cat,
      name: cat.charAt(0).toUpperCase() + cat.slice(1),
      description: {
        bugs: 'Bug screenshots and evidence',
        docs: 'Documentation files, PDFs, exports',
        screenshots: 'UI captures, before/after shots',
        assets: 'Logos, images, design files',
        discoveries: 'Things Susan finds during analysis',
        exports: 'Data exports, reports, backups',
        misc: 'Everything else'
      }[cat]
    }))
  });
});

/**
 * GET /api/files/stats - Library statistics
 */
router.get('/files/stats', async (req, res) => {
  const { project_slug } = req.query;

  try {
    const client = getClient();
    const stats = {
      total: 0,
      by_category: {}
    };

    const projects = project_slug ? [project_slug] : [];

    // If no specific project, list root to get all projects
    if (!project_slug) {
      const { data: rootData } = await client.storage
        .from(BUCKET_NAME)
        .list('', { limit: 100 });

      if (rootData) {
        rootData.forEach(item => {
          if (item.id) projects.push(item.name);
        });
      }
    }

    // Count files in each category for each project
    for (const proj of projects) {
      for (const cat of CATEGORIES) {
        const { data } = await client.storage
          .from(BUCKET_NAME)
          .list(`${proj}/${cat}`, { limit: 1000 });

        const count = data?.filter(f => f.name).length || 0;
        stats.by_category[cat] = (stats.by_category[cat] || 0) + count;
        stats.total += count;
      }
    }

    res.json({ success: true, stats, projects_scanned: projects.length });
  } catch (err) {
    logger.error('Stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
