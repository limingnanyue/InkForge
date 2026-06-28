import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from '@/components/Layout';
import Studio from '@/pages/Studio';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import Generate from '@/pages/Generate';
import Models from '@/pages/Models';
import Daemon from '@/pages/Daemon';
import ExportCenter from '@/pages/ExportCenter';
import Settings from '@/pages/Settings';
import Market from '@/pages/Market';
import Genres from '@/pages/Genres';
import TearDown from '@/pages/TearDown';

export default function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/studio" replace />} />
          <Route path="/studio" element={<Studio />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/generate" element={<Generate />} />
          <Route path="/models" element={<Models />} />
          <Route path="/daemon" element={<Daemon />} />
          <Route path="/export" element={<ExportCenter />} />
          <Route path="/market" element={<Market />} />
          <Route path="/genres" element={<Genres />} />
          <Route path="/teardown" element={<TearDown />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </Router>
  );
}
