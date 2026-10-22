import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.*;

/** Real ThreadPoolExecutor probes; no external libraries or sleep-based races. */
public class PoolExperiment {
    static class Work implements Runnable {
        final int id;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release;
        final List<Integer> started;
        Work(int id, CountDownLatch release, List<Integer> started) {
            this.id = id; this.release = release; this.started = started;
        }
        public void run() {
            started.add(id);
            entered.countDown();
            try {
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("release timeout");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    static void probe(String name, BlockingQueue<Runnable> queue, int submissions,
                      int expectedPool, int expectedQueue, int expectedRejects) throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        List<Integer> started = Collections.synchronizedList(new ArrayList<>());
        ThreadPoolExecutor pool = new ThreadPoolExecutor(2, 4, 60, TimeUnit.SECONDS,
                queue, new ThreadPoolExecutor.AbortPolicy());
        int rejected = 0;
        try {
            for (int id = 1; id <= submissions; id++) {
                Work work = new Work(id, release, started);
                int oldSize = pool.getPoolSize();
                boolean accepted = true;
                try { pool.execute(work); }
                catch (RejectedExecutionException e) { accepted = false; rejected++; }
                if (accepted && pool.getPoolSize() > oldSize && !work.entered.await(5, TimeUnit.SECONDS))
                    throw new AssertionError("worker did not start");
                System.out.printf("%s submit=%d accepted=%s pool=%d queued=%d%n",
                        name, id, accepted, pool.getPoolSize(), queue.size());
            }
            if (pool.getPoolSize() != expectedPool || queue.size() != expectedQueue || rejected != expectedRejects)
                throw new AssertionError("unexpected executor state");
            List<Integer> snapshot;
            synchronized (started) { snapshot = new ArrayList<>(started); }
            Collections.sort(snapshot);
            System.out.printf("%s started_before_release=%s rejected=%d%n", name, snapshot, rejected);
            if (name.equals("bounded") && !snapshot.equals(List.of(1,2,5,6)))
                throw new AssertionError("expected later tasks to start before queued tasks");
        } finally {
            release.countDown();
            pool.shutdown();
            if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
                pool.shutdownNow();
                throw new AssertionError("termination timeout");
            }
        }
        if (pool.getCompletedTaskCount() != submissions - rejected)
            throw new AssertionError("accepted work did not finish");
        System.out.printf("%s completed=%d%n", name, pool.getCompletedTaskCount());
    }

    public static void main(String[] args) throws Exception {
        probe("bounded", new ArrayBlockingQueue<>(2), 7, 4, 2, 1);
        probe("unbounded", new LinkedBlockingQueue<>(), 7, 2, 5, 0);
        probe("handoff", new SynchronousQueue<>(), 5, 4, 0, 1);
    }
}
